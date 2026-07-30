"""S2 record 级控制器识别：离线聚合原图的规范 OCR 结果（PLAN docs/007 §S2，T1 范围）。

输入口径（关键约束，与 PLAN 一致）：
- 唯一规范输入：<json_dir>/*.ocr.postprocessed.json。
  判断在代码中显式执行：文件名必须以 ".ocr.postprocessed.json" 结尾，
  且不含 ".rectified."（*.rectified.ocr.postprocessed.json 是矫正图派生物，不参与聚合）；
  原始 *.ocr.json 与 *.rectified.ocr.json 一律不参与。
- SHA-256 重复组沿用 dedup 报告（output/dedup_report.json + output/dedup_v2_report.json）：
  每组只保留 1 个代表文件参与聚合，其余标记为 excluded_duplicate；
  不直接采用 dedup 的 unique 列表（否则重复组整体漏掉）。

聚合规则（v1，刻意收敛）：
1. 按文件名前缀分组：v2 样本取 "..._recNN" 之前（含 recNN）为 record key；
   v1 旧样本（无 recNN，形如 boletuo_Z001_t1_炮筒）取 "_tN_" 之前的 品牌_机台号。
2. 每张图用 classify_ui.score_all_families 打分（与 find_ui_family 同一打分逻辑，
   返回各家族归一化置信度全向量）；record 级得分 = 各图得分逐家族累加（置信度投票，
   不做标题区加权）。
3. 多数决（累加向量 argmax）得 record 级 controller_family；全零 -> unknown。
4. 若提供 --labels（S1 的 ground_truth/machine_labels.json）且能匹配到机台，
   与标签不一致 -> 标记 conflict 进人工复核队列，不以先验覆盖图片证据。
   例外（T2）：0 图 record（整组 SHA-256 重复被排除、无图片证据）按 labels 的
   records 映射回填，label_check 标 "prior_filled"，不计 conflict 也不计 consistent。
   labels 文件缺失时照常聚合，labels 状态记为 "missing"。

报告中固化 OCR 快照：repo HEAD、output/json 最后提交 commit SHA、工作区是否 dirty、
postprocess.py 版本号与文件 SHA-256（防上游升级导致结论过期）。

用法：
    python scripts/aggregate_record.py output/json --labels ground_truth/machine_labels.json \
        --output output/record_classify_report.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from classify_ui import UI_FAMILY_KEYWORDS, score_all_families  # noqa: E402

DEFAULT_DEDUP_REPORTS = ["output/dedup_report.json", "output/dedup_v2_report.json"]
POSTPROCESS_PATH = Path(__file__).resolve().parent / "postprocess.py"

# record key 提取：v2 样本到 _recNN 为止；v1 旧样本到 _tN_ 之前
REC_V2_RE = re.compile(r"^(v2_.+?_rec\d+)_")
REC_V1_RE = re.compile(r"^(.+?)_t\d+_")


def is_canonical_input(path: Path) -> bool:
    """唯一规范输入判断：*.ocr.postprocessed.json 且非 rectified 变体。"""
    name = path.name
    return name.endswith(".ocr.postprocessed.json") and ".rectified." not in name


def record_key(stem: str) -> str:
    """从规范输入的文件名 stem 提取 record 分组键。"""
    m = REC_V2_RE.match(stem)
    if m:
        return m.group(1)
    m = REC_V1_RE.match(stem)
    if m:
        return m.group(1)
    # 命名变体兜底：整个 stem 作为 key，并在报告中可回溯（images 里可见原始文件名）
    print(f"[aggregate] WARN: 无法解析 record 前缀，整名作 key: {stem}", file=sys.stderr)
    return stem


def image_stem_candidates(image_name: str) -> list[str]:
    """dedup 报告里是图片文件名（*.jpeg），映射到 OCR stem。

    v2 的 dedup 报告文件名不带 "v2_" 前缀，而 output/json 下的 OCR 文件带，
    因此两种候选都要尝试。
    """
    base = image_name.rsplit(".", 1)[0]
    return [base, f"v2_{base}"]


def load_dedup_exclusions(report_paths: list[Path], canonical_stems: set[str]) -> tuple[dict[str, str], list[dict]]:
    """从 dedup 报告构建排除表。

    返回 (excluded: {stem: representative_stem}, groups_used: 有 >=2 个规范输入的组摘要)。
    每组只保留 1 个代表文件（组内有规范输入的文件按文件名排序取第一个）。
    """
    excluded: dict[str, str] = {}
    groups_used: list[dict] = []
    for rp in report_paths:
        if not rp.is_file():
            print(f"[aggregate] WARN: dedup 报告缺失，跳过: {rp}", file=sys.stderr)
            continue
        data = json.loads(rp.read_text())
        groups = data.get("duplicate_within_record", []) + data.get("duplicate_across_records", [])
        for g in groups:
            # 组内存在规范 OCR 输入的 stem
            stems_in_group: list[str] = []
            for img in g.get("files", []):
                for cand in image_stem_candidates(img):
                    if cand in canonical_stems:
                        stems_in_group.append(cand)
                        break
            stems_in_group = sorted(set(stems_in_group))
            if len(stems_in_group) < 2:
                continue
            representative = stems_in_group[0]
            for s in stems_in_group[1:]:
                excluded[s] = representative
            groups_used.append({
                "sha256": g.get("sha256", ""),
                "representative": representative,
                "excluded": stems_in_group[1:],
                "source_report": str(rp),
            })
    return excluded, groups_used


def load_image_scores(json_path: Path) -> dict:
    """加载一个规范输入，返回各家族置信度向量与逐图判定。"""
    data = json.loads(json_path.read_text())
    # postprocessed JSON 的文本行在 merged_rows（后处理合并产物）；兼容原始 lines 结构
    lines = data.get("merged_rows") or data.get("lines") or []
    scores = score_all_families(lines)
    if any(scores.values()):
        best = max(scores, key=scores.get)
        family, conf = best, scores[best]
    else:
        family, conf = "unknown", 0.0
    return {
        "file": json_path.name,
        "n_lines": len(lines),
        "ui_family": family,
        "ui_family_confidence": conf,
        "family_scores": scores,
    }


def match_machine_label(record: str, machines: dict) -> tuple[str | None, dict | None]:
    """record key -> machine_labels 条目（尽力匹配）。

    machine_id 规则为 品牌_机台号_控制器家族（如 伯乐_A01_KEBA）；
    record key 形如 v2_伯乐_A01_..._rec11 或 boletuo_Z001。
    匹配条件：machine_id 的 品牌_机台号 前缀整体出现在 record key 中。
    """
    for machine_id, info in machines.items():
        parts = machine_id.split("_")
        if len(parts) >= 2 and f"{parts[0]}_{parts[1]}" in record:
            return machine_id, info
    return None, None


def match_machine_by_rec_no(record: str, machines: dict) -> tuple[str | None, dict | None]:
    """按 machine_labels 的 records 映射匹配（先验回填专用，比前缀匹配更强）。

    record key 里的 recNN 必须出现在某机台的 records 列表中（如 rec09 ->
    伯乐_B01_B_AND_R.records=["rec07","rec09"]）。recNN 全局唯一，不会误配。
    """
    m = re.search(r"rec\d+", record)
    if not m:
        return None, None
    rec_no = m.group(0)
    for machine_id, info in machines.items():
        if rec_no in info.get("records", []):
            return machine_id, info
    return None, None


def git_snapshot(json_dir: Path) -> dict:
    """固化 OCR 产物快照：git commit SHA + 工作区状态 + postprocess.py 版本。"""
    snap: dict = {}
    try:
        snap["repo_head"] = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
        snap["ocr_json_last_commit"] = subprocess.run(
            ["git", "log", "-1", "--format=%H", "--", str(json_dir)],
            capture_output=True, text=True, check=True,
        ).stdout.strip() or None
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--", str(json_dir)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        snap["ocr_json_worktree_dirty"] = bool(dirty)
        if dirty:
            snap["ocr_json_dirty_files"] = dirty.splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        snap["git_error"] = f"{type(e).__name__}: {e}"

    pp_bytes = POSTPROCESS_PATH.read_bytes()
    snap["postprocess_file"] = str(POSTPROCESS_PATH.relative_to(POSTPROCESS_PATH.parents[1]))
    snap["postprocess_sha256"] = hashlib.sha256(pp_bytes).hexdigest()
    pp_version = None
    for line in pp_bytes.decode().splitlines():
        m = re.match(r'^__version__\s*=\s*["\'](.+?)["\']', line)
        if m:
            pp_version = m.group(1)
            break
    snap["postprocess_version"] = pp_version
    return snap


def main():
    ap = argparse.ArgumentParser(description="S2 record 级控制器识别离线聚合")
    ap.add_argument("json_dir", nargs="?", default="output/json",
                    help="规范 OCR JSON 目录（默认 output/json）")
    ap.add_argument("--labels", default="ground_truth/machine_labels.json",
                    help="S1 机器级标签（缺失时照常聚合，准确率验收留待 T2）")
    ap.add_argument("--output", "-o", default="output/record_classify_report.json")
    ap.add_argument("--dedup", nargs="*", default=DEFAULT_DEDUP_REPORTS,
                    help="dedup 报告路径（默认 output/dedup_report.json output/dedup_v2_report.json）")
    args = ap.parse_args()

    json_dir = Path(args.json_dir)
    if not json_dir.is_dir():
        sys.exit(f"[aggregate] ERROR: 目录不存在: {json_dir}")

    # 1. 发现唯一规范输入（显式排除 rectified 变体与原始 .ocr.json）
    canonical = sorted(p for p in json_dir.glob("*.ocr.postprocessed.json") if is_canonical_input(p))
    if not canonical:
        sys.exit(f"[aggregate] ERROR: {json_dir} 下无规范输入 *.ocr.postprocessed.json")
    canonical_stems = {p.name[: -len(".ocr.postprocessed.json")] for p in canonical}

    # 2. SHA-256 重复组：每组只取 1 个代表文件
    excluded, dup_groups_used = load_dedup_exclusions(
        [Path(p) for p in args.dedup], canonical_stems
    )

    # 3. 按 record 分组 + 逐图打分（被排除的重复文件不参与）
    records: dict[str, dict] = {}
    n_participating = 0
    unknown_images: list[str] = []
    for p in canonical:
        stem = p.name[: -len(".ocr.postprocessed.json")]
        rec = record_key(stem)
        entry = records.setdefault(rec, {
            "controller_family": None,
            "family_scores": {k: 0.0 for k in UI_FAMILY_KEYWORDS},
            "n_images": 0,
            "n_unknown_images": 0,
            "images": [],
            "excluded_duplicates": [],
        })
        if stem in excluded:
            entry["excluded_duplicates"].append({
                "file": p.name, "representative": f"{excluded[stem]}.ocr.postprocessed.json",
            })
            continue
        img = load_image_scores(p)
        entry["images"].append(img)
        entry["n_images"] += 1
        n_participating += 1
        for fam, sc in img["family_scores"].items():
            entry["family_scores"][fam] = round(entry["family_scores"][fam] + sc, 3)
        if img["ui_family"] == "unknown":
            entry["n_unknown_images"] += 1
            unknown_images.append(p.name)

    # 4. 多数决得 record 级 controller_family
    for rec, entry in records.items():
        scores = entry["family_scores"]
        if entry["n_images"] == 0 or not any(scores.values()):
            entry["controller_family"] = "unknown"
            continue
        best = max(scores, key=scores.get)
        entry["controller_family"] = best
        # 领先幅度（第一名 - 第二名），供人工复核参考
        ranked = sorted(scores.values(), reverse=True)
        entry["score_margin"] = round(ranked[0] - (ranked[1] if len(ranked) > 1 else 0.0), 3)

    # 5. 与 S1 标签比对（labels 缺失也能跑通）
    labels_path = Path(args.labels)
    labels_status = "missing"
    conflicts: list[dict] = []
    if labels_path.is_file():
        labels_data = json.loads(labels_path.read_text())
        machines = labels_data.get("machines", {})
        labels_status = "loaded"
        # 为"有标签但完全无 OCR 产物"的 record 建 0 图占位：
        # 如 rec09 全组与 rec07 SHA-256 重复，按 dedup 处置不需要单独 OCR，
        # 但 record 本身应进报告（先验回填 prior_filled），不能静默缺失。
        labeled_rec_nos = {rn for info in machines.values() for rn in info.get("records", [])}
        for rp in [Path(p) for p in args.dedup]:
            if not rp.is_file():
                continue
            d = json.loads(rp.read_text())
            for g in d.get("duplicate_within_record", []) + d.get("duplicate_across_records", []):
                for img in g.get("files", []):
                    for cand in image_stem_candidates(img):
                        m = re.match(r"^(v2_.+?_rec\d+)_", cand)
                        if not m:
                            continue
                        key = m.group(1)
                        rec_no = re.search(r"rec\d+", key).group(0)
                        if key not in records and rec_no in labeled_rec_nos:
                            records[key] = {
                                "controller_family": None,
                                "family_scores": {k: 0.0 for k in UI_FAMILY_KEYWORDS},
                                "n_images": 0,
                                "n_unknown_images": 0,
                                "images": [],
                                "excluded_duplicates": [],
                                "stub_note": "无 OCR 产物（整组与兄弟 record 重复，未单独跑 OCR）",
                            }
        for rec, entry in records.items():
            # 先验回填（T2，2026-07-30）：仅 0 图 record（整组 SHA-256 重复被排除，
            # 没有任何图片证据可聚合）用 machine_labels 的 records 映射回填。
            # prior_filled 与图片证据区分：不计入 conflict，也不计为 consistent。
            if entry["n_images"] == 0:
                machine_id, info = match_machine_by_rec_no(rec, machines)
                if info is None:
                    machine_id, info = match_machine_label(rec, machines)
                entry["machine_id"] = machine_id
                label_family = (info or {}).get("controller_family", "")
                if label_family:
                    entry["controller_family"] = label_family
                    entry["label_controller_family"] = label_family
                    entry["label_check"] = "prior_filled"
                    entry["prior_source"] = machine_id
                else:
                    entry["label_check"] = "unknown" if info else "no_matching_machine"
                continue
            machine_id, info = match_machine_label(rec, machines)
            entry["machine_id"] = machine_id
            if info is None:
                entry["label_check"] = "no_matching_machine"
                continue
            label_family = info.get("controller_family", "")
            entry["label_controller_family"] = label_family
            # 大小写归一：classify_ui 用 ZizES 等历史命名，labels 用 ZIZES/KEBA 全大写
            same_family = entry["controller_family"].upper() == label_family.upper()
            if label_family and entry["controller_family"] != "unknown" \
                    and not same_family:
                entry["label_check"] = "conflict"
                conflicts.append({
                    "record": rec,
                    "machine_id": machine_id,
                    "aggregated_family": entry["controller_family"],
                    "label_family": label_family,
                    "action": "人工复核，不以先验覆盖图片证据",
                })
            else:
                if entry["controller_family"] == "unknown":
                    entry["label_check"] = "unknown"
                else:
                    entry["label_check"] = "consistent" if label_family else "label_family_empty"
    else:
        print(f"[aggregate] WARN: labels 缺失（S1 未完成），跳过冲突率/准确率验收: {labels_path}",
              file=sys.stderr)

    # 6. 汇总 + OCR 快照固化
    unknown_records = sorted(r for r, e in records.items() if e["controller_family"] == "unknown")
    check_counts: dict[str, int] = {}
    for e in records.values():
        lc = e.get("label_check")
        if lc:
            check_counts[lc] = check_counts.get(lc, 0) + 1
    n_consistent = check_counts.get("consistent", 0)
    n_prior_filled = check_counts.get("prior_filled", 0)
    n_labeled = n_consistent + check_counts.get("conflict", 0) \
        + check_counts.get("unknown", 0) + n_prior_filled
    n_image_evidence = n_labeled - n_prior_filled  # 有图片证据的有标签 record
    acceptance = {
        # T2 验收口径：consistent / 有标签的 record 总数；prior_filled 单列（见下）
        "record_classification_accuracy": round(n_consistent / n_labeled, 4) if n_labeled else None,
        "n_labeled_records": n_labeled,
        "n_consistent": n_consistent,
        "n_prior_filled": n_prior_filled,
        # 参考口径：仅对有图片证据的 record（prior_filled 无图片证据，剔除分母）
        "image_evidence_accuracy": round(n_consistent / n_image_evidence, 4) if n_image_evidence else None,
        "prior_filled_note": "prior_filled = 整组 SHA-256 重复被排除的 0 图 record，"
                             "按 machine_labels records 映射回填，不计 consistent/conflict",
        "label_check_counts": check_counts,
    }
    report = {
        "version": "1.0",
        "plan_ref": "docs/007_PLAN_20260730_端到端薄切片实施计划.md §S2",
        "input_spec": {
            "canonical_pattern": "*.ocr.postprocessed.json（排除 *.rectified.* 变体；原始 .ocr.json 不参与）",
            "json_dir": str(json_dir),
            "canonical_files": len(canonical),
            "participating_images": n_participating,
            "excluded_duplicate_images": sum(len(g["excluded"]) for g in dup_groups_used),
            "dedup_groups_applied": dup_groups_used,
        },
        "ocr_snapshot": git_snapshot(json_dir),
        "labels": {"path": str(labels_path), "status": labels_status},
        "summary": {
            "n_records": len(records),
            "n_participating_images": n_participating,
            "n_unknown_images": len(unknown_images),
            "unknown_image_ratio": round(len(unknown_images) / n_participating, 4) if n_participating else None,
            "n_unknown_records": len(unknown_records),
            "n_conflicts": len(conflicts),
        },
        "acceptance": acceptance,
        "unknown_images": sorted(unknown_images),
        "unknown_records": unknown_records,
        "conflicts": conflicts,
        "records": dict(sorted(records.items())),
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    print(f"[aggregate] 规范输入 {len(canonical)} 个，参与聚合 {n_participating} 张，"
          f"重复排除 {report['input_spec']['excluded_duplicate_images']} 张")
    print(f"[aggregate] record 数 {len(records)}，unknown 图片 {len(unknown_images)} 张"
          f"（{report['summary']['unknown_image_ratio']}），unknown record {len(unknown_records)} 个，"
          f"冲突 {len(conflicts)} 个")
    print(f"[aggregate] 验收: consistent={n_consistent} conflict={check_counts.get('conflict', 0)} "
          f"unknown={check_counts.get('unknown', 0)} prior_filled={n_prior_filled} "
          f"无标签={check_counts.get('no_matching_machine', 0)} | "
          f"record 分类准确率={acceptance['record_classification_accuracy']} "
          f"（图片证据口径={acceptance['image_evidence_accuracy']}）")
    print(f"[aggregate] 报告 -> {out_path}")
    for rec, entry in report["records"].items():
        print(f"  {rec}: {entry['controller_family']} "
              f"(images={entry['n_images']}, unknown={entry['n_unknown_images']}, "
              f"scores={entry['family_scores']})")


if __name__ == "__main__":
    main()
