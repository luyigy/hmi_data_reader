"""S4 真值比对：提取结果 vs 真值，报告 6 项验收指标（031 PLAN S01 改版）。

指标（公式与 PLAN §3 统一）：
1. controller_classification_accuracy — |family 一致的图| / |全部图|（大小写归一）
2. page_classification_accuracy       — |page_type 一致的图| / |全部图|
3. field_completeness                 — |提取非空的数值字段元素| / |计分真值非空数值字段元素|
4. numeric_accuracy                   — |匹配真值(允许误差)的数值字段元素| / |计分真值非空数值字段元素|，门槛 >= 95%
5. auto_import_ratio                  — |status=ok 的图| / |全部图|
6. error_auto_import_rate             — |误识别但仍 status=ok 的字段元素| / |status=ok 图的字段元素|，门槛严格 = 0
7. rejection_accuracy                 — |正确拒识(status!=ok)的 allow_auto_import=false 图| / |allow_auto_import=false 图|，门槛严格 = 1，空分母 N/A

计分口径（023 PLAN §3）：仅真值 allow_auto_import=false 且提取 status != ok 的
正确拒识图片，其数值元素从 3/4 两项的分母、分子中排除；错误放行（status=ok）
的负样本不排除。报告 scoring 块保留全量/计分计数与排除图片及原因。

数值字段元素 = 标量字段本身或数组字段的单个元素；数组长度不一致时，真值侧超出的
元素计为"提取缺失"（不完整 + 不匹配）。

双模式（031 PLAN §4.5，NUMERIC_FIELDS 硬编码清单已删除）：
- contract 模式（真值目录含 *.truth.yml，datasets/ 契约真值）：按字段目录
  value_type 判定数值/文本字段与容差；真值出现目录未登记字段立即硬失败，
  不给未接入字段编造单位语义。报告标 mode=contract；全部硬门禁通过且
  rejection_accuracy 非 N/A 时 lifecycle_eligible=true，否则 false
  （rejection N/A 不得晋级）。
- legacy 模式（真值目录含 *.truth.json，ground_truth/ 历史真值）：按真值值
  类型动态枚举数值键（标量数值/数值数组/文本标量），继续出对比报告，但一律
  lifecycle_eligible=false——老真值无契约绑定，不得用于晋级。

用法：
    python scripts/verify_accuracy.py output/extracted --truth ground_truth/zizes_temperature \
        --output output/accuracy_report.json
    python scripts/verify_accuracy.py output/extracted --truth datasets/holdout/<profile_id> \
        --output output/accuracy_report.json   # contract 模式
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

TOLERANCE = 0.5
GATE_NUMERIC_ACCURACY = 0.95
GATE_ERROR_AUTO_IMPORT_RATE = 0.0

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = REPO_ROOT / "contracts" / "field_catalog.json"

# 字段目录 value_type -> 计分类型
NUMERIC_VALUE_TYPES = {"float", "int", "list[float]", "list[int]"}
TEXT_VALUE_TYPES = {"str", "string"}


def truth_scorable_keys(fields: dict | None) -> dict[str, str]:
    """legacy 模式：真值 fields 里可计分键 -> numeric/text（按真值值类型动态枚举）。"""
    keys: dict[str, str] = {}
    for k, v in (fields or {}).items():
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            keys[k] = "numeric"
        elif isinstance(v, str):
            keys[k] = "text"
        elif isinstance(v, list) and v and all(
                isinstance(x, (int, float)) and not isinstance(x, bool) for x in v):
            keys[k] = "numeric"
    return keys


def flatten_scorable(fields: dict | None, scorable: dict[str, str]) -> dict:
    """{field: scalar|[...]} -> {field 或 field[i]: value}；缺失/None 记为 None。"""
    flat: dict = {}
    if not fields:
        return flat
    for name in scorable:
        v = fields.get(name)
        if isinstance(v, list):
            for i, item in enumerate(v):
                flat[f"{name}[{i}]"] = item
        else:
            flat[name] = v
    return flat


def compare_elements(t_flat: dict, e_flat: dict, scorable: dict[str, str],
                     tolerances: dict[str, float]) -> list[dict]:
    """逐元素比对：数值按容差、文本按等值。真值 None 不计入分母。"""
    elements = []
    for key, t_val in t_flat.items():
        if t_val is None:
            continue  # 真值空缺不计入分母
        base = key.split("[", 1)[0]
        e_val = e_flat.get(key)
        if scorable.get(base) == "text" or isinstance(t_val, str) or isinstance(e_val, str):
            matched = e_val is not None and e_val == t_val
        else:
            tol = tolerances.get(base, TOLERANCE)
            matched = (e_val is not None
                       and isinstance(e_val, (int, float))
                       and not isinstance(e_val, bool)
                       and abs(e_val - t_val) <= tol)
        elements.append({
            "field": key,
            "truth": t_val,
            "extracted": e_val,
            "present": e_val is not None,
            "matched": matched,
        })
    return elements


def compare_one(truth: dict, extracted: dict | None, scorable: dict[str, str],
                tolerances: dict[str, float]) -> dict:
    """单图比对，返回该图的逐元素明细与计数。"""
    t_family = truth.get("controller_family", "")
    t_page = truth.get("page_type", "")
    e_family = (extracted or {}).get("controller_family", "")
    e_page = (extracted or {}).get("page_type", "")
    status = (extracted or {}).get("status", "reject")

    t_flat = flatten_scorable(truth.get("fields"), scorable)
    e_flat = flatten_scorable(extracted.get("fields") if extracted else None, scorable)
    elements = compare_elements(t_flat, e_flat, scorable, tolerances)

    return {
        "image": truth["image"],
        "status": status,
        "allow_auto_import": truth.get("allow_auto_import"),
        "family_truth": t_family,
        "family_extracted": e_family,
        "family_match": bool(t_family) and t_family.upper() == str(e_family).upper(),
        "page_truth": t_page,
        "page_extracted": e_page,
        "page_match": bool(t_page) and t_page == e_page,
        "n_elements": len(elements),
        "n_present": sum(1 for e in elements if e["present"]),
        "n_matched": sum(1 for e in elements if e["matched"]),
        "elements": elements,
    }


def load_legacy_truths(truth_dir: Path) -> tuple[list[dict], dict[str, str],
                                                 dict[str, float]]:
    """legacy *.truth.json：数值键按真值值类型动态枚举（跨文件取并集）。"""
    truths = []
    scorable: dict[str, str] = {}
    for tf in sorted(truth_dir.glob("*.truth.json")):
        raw = json.loads(tf.read_text(encoding="utf-8"))
        truths.append({
            "image": raw.get("image") or tf.name,
            "controller_family": raw.get("controller_family", ""),
            "page_type": raw.get("page_type", ""),
            "allow_auto_import": raw.get("allow_auto_import"),
            "fields": raw.get("fields") or {},
        })
    for truth in truths:
        scorable.update(truth_scorable_keys(truth["fields"]))
    tolerances = {k: TOLERANCE for k in scorable}
    return truths, scorable, tolerances


def load_contract_truths(truth_dir: Path, catalog: dict) -> tuple[list[dict],
                                                                 dict[str, str],
                                                                 dict[str, float]]:
    """contract *.truth.yml：按字段目录 value_type 计分；未登记字段硬失败。"""
    catalog_fields = catalog.get("fields", {})
    truths = []
    unregistered: dict[str, list[str]] = {}
    for tf in sorted(truth_dir.glob("*.truth.yml")):
        raw = yaml.safe_load(tf.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or not isinstance(raw.get("fields"), dict):
            sys.exit(f"[verify] ERROR: contract 真值缺少 fields mapping: {tf}")
        fields = raw["fields"]
        miss = sorted(k for k in fields if k not in catalog_fields)
        if miss:
            unregistered[raw.get("case_id") or tf.name] = miss
        image = (raw.get("image") or {}).get("file") or f"{raw.get('case_id', tf.stem)}"
        truths.append({
            "image": image,
            "controller_family": raw.get("controller_family", ""),
            "page_type": raw.get("page_type", ""),
            "allow_auto_import": raw.get("allow_auto_import"),
            "fields": fields,
        })
    if unregistered:
        sys.exit(f"[verify] ERROR: contract 真值出现字段目录未登记字段（不给未接入字段"
                 f"编造单位语义，先在 contracts/field_catalog.json 登记）: "
                 f"{json.dumps(unregistered, ensure_ascii=False)}")
    scorable: dict[str, str] = {}
    tolerances: dict[str, float] = {}
    for name, spec in catalog_fields.items():
        if not isinstance(spec, dict):
            continue
        vtype = spec.get("value_type")
        if vtype in NUMERIC_VALUE_TYPES:
            scorable[name] = "numeric"
            tol = spec.get("tolerance")
            tolerances[name] = tol if isinstance(tol, (int, float)) else TOLERANCE
        elif vtype in TEXT_VALUE_TYPES:
            scorable[name] = "text"
    return truths, scorable, tolerances


def build_report(per_image: list[dict], missing_extraction: list[str],
                 *, mode: str, catalog_version: str | None) -> dict:
    n = len(per_image)

    # 023 PLAN §3 拒识口径：只有真值 allow_auto_import=false 且提取 status != ok 的
    # 正确拒识图片，其数值元素才从 field_completeness / numeric_accuracy 计分排除；
    # 错误放行（status=ok）的负样本不排除。controller/page/auto_import_ratio 仍在
    # 全量上如实报告；rejection_accuracy 为独立安全指标，空分母记 N/A（不宣称 PASS）
    for p in per_image:
        p["correct_reject"] = p["allow_auto_import"] is False and p["status"] != "ok"
    scored = [p for p in per_image if not p["correct_reject"]]
    excluded = [p for p in per_image if p["correct_reject"]]
    neg = [p for p in per_image if p["allow_auto_import"] is False]

    def totals(rows: list[dict]) -> dict:
        return {
            "n_images": len(rows),
            "n_elements": sum(p["n_elements"] for p in rows),
            "n_present": sum(p["n_present"] for p in rows),
            "n_matched": sum(p["n_matched"] for p in rows),
        }

    raw_totals = totals(per_image)
    scored_totals = totals(scored)
    ok_images = [p for p in per_image if p["status"] == "ok"]
    ok_elements = sum(p["n_elements"] for p in ok_images)
    ok_errors = sum(p["n_elements"] - p["n_matched"] for p in ok_images)

    metrics = {
        "controller_classification_accuracy": round(sum(p["family_match"] for p in per_image) / n, 4),
        "page_classification_accuracy": round(sum(p["page_match"] for p in per_image) / n, 4),
        "field_completeness": round(scored_totals["n_present"] / scored_totals["n_elements"], 4)
            if scored_totals["n_elements"] else None,
        "numeric_accuracy": round(scored_totals["n_matched"] / scored_totals["n_elements"], 4)
            if scored_totals["n_elements"] else None,
        "auto_import_ratio": round(len(ok_images) / n, 4),
        "error_auto_import_rate": round(ok_errors / ok_elements, 4) if ok_elements else None,
        "rejection_accuracy": round(sum(p["status"] != "ok" for p in neg) / len(neg), 4) if neg else None,
    }
    gates = {
        "numeric_accuracy >= 0.95": (metrics["numeric_accuracy"] is not None
                                     and metrics["numeric_accuracy"] >= GATE_NUMERIC_ACCURACY),
        "error_auto_import_rate == 0": (metrics["error_auto_import_rate"] is not None
                                        and metrics["error_auto_import_rate"] == GATE_ERROR_AUTO_IMPORT_RATE),
        "rejection_accuracy == 1": ("N/A" if metrics["rejection_accuracy"] is None
                                    else metrics["rejection_accuracy"] == 1.0),
    }
    # 晋级资格（031 PLAN §4.3/§4.5）：legacy 一律 false；contract 须三门禁全过
    # 且 rejection_accuracy 非 N/A（空分母不得晋级）
    if mode == "legacy":
        lifecycle_eligible = False
        lifecycle_note = ("legacy ground_truth 无契约绑定（无 meta/hash/分区治理），"
                          "报告仅供对比，不得用于 profile 晋级")
    else:
        lifecycle_eligible = all(v is True for v in gates.values())
        lifecycle_note = ("contract dataset 三门禁全过且负例在场，可作为晋级输入"
                          if lifecycle_eligible else
                          "门禁未全过或 rejection_accuracy 为 N/A（空分母不得晋级）")
    report = {
        "version": "2.0",
        "mode": mode,
        "contract_version": catalog_version,
        "lifecycle_eligible": lifecycle_eligible,
        "lifecycle_note": lifecycle_note,
        "plan_ref": "docs/007_PLAN_20260730_端到端薄切片实施计划.md §3；拒识口径 docs/023_PLAN_20260801_伯乐S3拒识口径与定向收口.md §3；双模式 031 PLAN §4.5",
        "tolerance": TOLERANCE,
        "n_images": n,
        "n_negative": len(neg),
        "metrics": metrics,
        "gates": gates,
        "poc_pass": all(v is True or v == "N/A" for v in gates.values()),
        "gate_semantics": "PoC 可跑通判定：达标 = 允许进入扩样验证，不代表许可生产环境真实自动入库；空分母 numeric/error 门 FAIL，rejection 空分母记 N/A（不宣称 PASS，且 N/A 不得用于晋级）",
        "scoring": {
            "rule": "仅真值 allow_auto_import=false 且提取 status != ok 的正确拒识图，其数值元素从 field_completeness/numeric_accuracy 分母分子排除；错误放行负样本不排除",
            "raw_totals": raw_totals,
            "scored_totals": scored_totals,
            "excluded_images": [
                {"image": p["image"], "n_elements": p["n_elements"],
                 "reason": f"correct_reject(allow_auto_import=false, status={p['status']})"}
                for p in excluded
            ],
        },
        "missing_extraction": missing_extraction,
        "per_image": [
            {k: v for k, v in p.items() if k != "elements"} for p in per_image
        ],
        "mismatched_elements": [
            {"image": p["image"], **e}
            for p in per_image for e in p["elements"] if not e["matched"]
        ],
    }
    return report


def main():
    ap = argparse.ArgumentParser(description="S4 提取结果 vs 真值：6 项验收指标")
    ap.add_argument("extracted_dir", help="extract_fields 输出目录（*.fields.json）")
    ap.add_argument("--truth", required=True, help="真值目录（*.truth.yml 契约真值或 *.truth.json 历史真值）")
    ap.add_argument("--output", "-o", required=True)
    ap.add_argument("--catalog", default=str(DEFAULT_CATALOG),
                    help="contract 模式字段目录（默认 contracts/field_catalog.json）")
    args = ap.parse_args()

    extracted_dir = Path(args.extracted_dir)
    truth_dir = Path(args.truth)

    if list(truth_dir.glob("*.truth.yml")):
        mode = "contract"
        catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
        truths, scorable, tolerances = load_contract_truths(truth_dir, catalog)
        catalog_version = catalog.get("contract_version")
    elif list(truth_dir.glob("*.truth.json")):
        mode = "legacy"
        catalog_version = None
        truths, scorable, tolerances = load_legacy_truths(truth_dir)
    else:
        sys.exit(f"[verify] ERROR: 真值目录为空（无 *.truth.yml 或 *.truth.json）: {truth_dir}")

    per_image = []
    missing_extraction = []
    for truth in truths:
        stem = Path(truth["image"]).stem
        ef = extracted_dir / f"{stem}.fields.json"
        extracted = json.loads(ef.read_text()) if ef.is_file() else None
        if extracted is None:
            missing_extraction.append(truth["image"])
        per_image.append(compare_one(truth, extracted, scorable, tolerances))

    report = build_report(per_image, missing_extraction,
                          mode=mode, catalog_version=catalog_version)
    metrics, gates = report["metrics"], report["gates"]
    excluded = report["scoring"]["excluded_images"]

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    print(f"[verify] mode={mode}，{report['n_images']} 张真值图，提取缺失 "
          f"{len(missing_extraction)} 张，计分排除 {len(excluded)} 张")
    for k, v in metrics.items():
        print(f"  {k}: {v}")
    for k, v in gates.items():
        mark = "N/A" if v == "N/A" else ("PASS" if v else "FAIL")
        print(f"  gate {k}: {mark}")
    print(f"  lifecycle_eligible: {report['lifecycle_eligible']}"
          f"（{report['lifecycle_note']}）")
    print(f"[verify] report -> {out_path}")


if __name__ == "__main__":
    main()
