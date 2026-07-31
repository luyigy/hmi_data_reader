"""013_PLAN S2 第一步：日精 TACT 家族大表只读盘点 + 候选清单（不下载附件）。

口径沿用 009 S1（docs/010_HANDOVER）：
- bot + raw API 只读 records/search（品牌 contains 日精），不下载附件、不向飞书写入；
- 家族预筛只使用人工核验过的机台级证据（ground_truth/machine_labels.json 中
  日精_A06/B09/B10 = TACT，经位置编号关联），禁止按日精品牌直接推断 TACT，
  无证据机台一律 UNKNOWN 单列待裁定；
- 疑似重复组（同机台同字节数）只保留最早日期代表进入候选池，内容级 SHA-256
  去重待获批下载后执行；
- 候选清单固定 seed、单机台上限 6（沿用 009 用户批准的 3 台 × 6 张结构），
  状态 PENDING_USER_APPROVAL，用户批准前禁止下载。

用法：
    python3 scripts/s2_tact_pool_inventory.py
"""
import json
import random
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE = "tbl5KKYuANqGpycE"
BRAND = "日精"
ATTACH_FIELD = "成型条件-炮筒温度设定"
FIELD_NAMES = ["品牌", "注塑机ID", "位置编号", "日期", ATTACH_FIELD]

SEED = 20260731
TARGETS_PER_MACHINE = 6      # 沿用 009 批准结构：单机台上限 6（=20×30% 的降级口径）
ALTERNATES_PER_MACHINE = 4

# 人工核验证据（ground_truth/machine_labels.json，王为 2026-07-30 核验）：
# 位置编号 -> (家族, 证据条目)
VERIFIED_POSITION_FAMILY = {
    "A06": ("TACT", "machine_labels.json 日精_A06_TACT：工程监视/生产情报/经历菜单为日精 TACT 风格，王为核验"),
    "B09": ("TACT", "machine_labels.json 日精_B09_TACT：蓝色按钮 UI 与 TACT5 软件同族，王为核验"),
    "B10": ("TACT", "machine_labels.json 日精_B10_TACT：屏幕面板上方 TACT 5 标识，王为核验"),
}

TZ_CN = timezone(timedelta(hours=8))
INVENTORY_OUT = Path("output/tact_pool_inventory.json")
CANDIDATES_OUT = Path("output/tact_expansion_candidates.json")


def search_all_records():
    body = {
        "field_names": FIELD_NAMES,
        "filter": {"conjunction": "and", "conditions": [
            {"field_name": "品牌", "operator": "contains", "value": [BRAND]}]},
    }
    res = subprocess.run([
        "lark-cli", "api", "POST",
        f"/open-apis/bitable/v1/apps/{BASE}/tables/{TABLE}/records/search",
        "--as", "bot",
        "--params", json.dumps({"page_size": 500}),
        "--data", json.dumps(body, ensure_ascii=False),
        "--page-all", "--page-limit", "0",
        "--json",
    ], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"records/search failed: {res.stderr or res.stdout[:2000]}")
    data = json.loads(res.stdout)["data"]
    items = data["items"]
    total = data.get("total")
    if total is not None and len(items) != total:
        raise RuntimeError(f"分页不完整：items={len(items)} total={total}")
    return items


def first_text(value):
    if isinstance(value, list):
        return str(value[0]) if value else ""
    return "" if value is None else str(value)


def parse_record(item):
    f = item["fields"]
    date_ms = f.get("日期")
    date = (datetime.fromtimestamp(date_ms / 1000, tz=TZ_CN).strftime("%Y-%m-%d")
            if isinstance(date_ms, (int, float)) else None)
    atts = f.get(ATTACH_FIELD) or []
    att = atts[0] if atts else None
    return {
        "record_id": item["record_id"],
        "machine": first_text(f.get("注塑机ID")) or "UNKNOWN_ID",
        "position": first_text(f.get("位置编号")),
        "date": date,
        "attachment": ({
            "file_token": att.get("file_token"),
            "name": att.get("name"),
            "size": att.get("size"),
            "type": att.get("type"),
            "count": len(atts),
        } if att else None),
    }


def family_of(positions):
    """仅按人工核验过的位置证据判族；混合/未知位置一律 UNKNOWN。"""
    fams = {VERIFIED_POSITION_FAMILY[p][0] for p in positions if p in VERIFIED_POSITION_FAMILY}
    if fams == {"TACT"} and positions and all(p in VERIFIED_POSITION_FAMILY for p in positions):
        return "TACT"
    return "UNKNOWN"


def main():
    items = search_all_records()
    records = [parse_record(i) for i in items]
    print(f"records: {len(records)}")

    # ---- 按机台聚合 ----
    machines = defaultdict(list)
    for r in records:
        machines[r["machine"]].append(r)

    per_machine = {}
    for mid, rs in sorted(machines.items()):
        positions = sorted({r["position"] for r in rs if r["position"]})
        fam = family_of(positions)
        dates = sorted(r["date"] for r in rs if r["date"])
        with_att = [r for r in rs if r["attachment"]]
        if fam == "TACT":
            evidence = "; ".join(VERIFIED_POSITION_FAMILY[p][1] for p in positions)
        else:
            evidence = "无可见证据：该机台位置不在已核验 machine_labels（日精_A06/B09/B10=TACT）中，禁止按日精品牌推断"
        per_machine[mid] = {
            "records": len(rs),
            "with_attachment": len(with_att),
            "attachments": sum(r["attachment"]["count"] for r in with_att),
            "positions": positions,
            "family_prescreen": fam,
            "family_evidence": evidence,
            "date_span": [dates[0], dates[-1]] if dates else None,
            "distinct_dates": len(set(dates)),
        }

    # ---- 疑似重复组（同机台同字节数），只留最早日期代表 ----
    dup_groups, dup_excess = [], []
    pool = []
    for mid, rs in sorted(machines.items()):
        if per_machine[mid]["family_prescreen"] != "TACT":
            continue
        by_size = defaultdict(list)
        for r in rs:
            if r["attachment"]:
                by_size[r["attachment"]["size"]].append(r)
        for size, group in by_size.items():
            group.sort(key=lambda r: (r["date"] or "9999", r["record_id"]))
            if len(group) > 1:
                dup_groups.append({"machine": mid, "size_bytes": size,
                                   "records": [g["record_id"] for g in group],
                                   "kept": group[0]["record_id"]})
                dup_excess.extend(group[1:])
            pool.append(group[0])
    dup_excess_ids = {r["record_id"] for r in dup_excess}

    # ---- 候选清单：固定 seed，机台内 shuffle，目标 6 + 候补 4 ----
    tact_machines = sorted(m for m in machines if per_machine[m]["family_prescreen"] == "TACT")
    rng = random.Random(SEED)
    per_machine_picks = {}
    for mid in tact_machines:
        machine_pool = [p for p in pool if p["machine"] == mid]
        machine_pool.sort(key=lambda r: (r["date"] or "9999", r["record_id"]))  # 确定性输入
        rng.shuffle(machine_pool)
        per_machine_picks[mid] = {
            "targets": machine_pool[:TARGETS_PER_MACHINE],
            "alternates": machine_pool[TARGETS_PER_MACHINE:TARGETS_PER_MACHINE + ALTERNATES_PER_MACHINE],
        }
    targets, alternates = [], []
    rank = 1
    for mid in tact_machines:
        for e in per_machine_picks[mid]["targets"]:
            targets.append(_entry(e, rank))
            rank += 1
    for mid in tact_machines:
        for e in per_machine_picks[mid]["alternates"]:
            alternates.append(_entry(e, rank))
            rank += 1

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    inventory = {
        "generated_at": generated_at,
        "generator": "kimi-code S2 (013_PLAN)",
        "source": {
            "base_token": BASE,
            "table_id": TABLE,
            "filter": "品牌 contains 日精",
            "access": "bot + raw API 只读（records/search），未下载任何附件，未向飞书写入",
        },
        "totals": {
            "records": len(records),
            "records_with_attachment": sum(1 for r in records if r["attachment"]),
            "records_without_attachment": sum(1 for r in records if not r["attachment"]),
            "attachments_total": sum(r["attachment"]["count"] for r in records if r["attachment"]),
            "date_span": [min(r["date"] for r in records if r["date"]),
                          max(r["date"] for r in records if r["date"])],
            "distinct_dates": len({r["date"] for r in records if r["date"]}),
        },
        "family_prescreen": {
            "method": "仅使用人工核验过的机台级证据（ground_truth/machine_labels.json 日精_A06/B09/B10=TACT，"
                      "经位置编号关联大表注塑机ID）；禁止按日精品牌直接推断 TACT；无证据机台一律 UNKNOWN",
        },
        "per_machine": per_machine,
        "suspected_duplicate_groups": dup_groups,
        "notes": [
            "疑似重复按同机台同字节数判定，附件元数据无内容 SHA-256，内容级去重待获批下载后完成",
            "状态（正常/报警）与质量分布元数据不可判，全部 unknown_pending_download",
            "获批下载后须先对本地校准/遗留图片（S1 校准集 13 张、samples_v2 rec02–05 日精）做 SHA-256 比对，"
            "命中者按候补固定顺序替换，保证校准集与验收集隔离",
        ],
    }
    INVENTORY_OUT.write_text(json.dumps(inventory, ensure_ascii=False, indent=2))

    candidates = {
        "generated_at": generated_at,
        "generator": "kimi-code S2 (013_PLAN)",
        "status": "PENDING_USER_APPROVAL",
        "selection_spec": {
            "random_seed": SEED,
            "pool": "family_prescreen=TACT（位置 A06/B09/B10，机台级人工核验证据）且含炮筒温度设定附件的大表记录",
            "exclusions": [
                "疑似重复组（同机台同字节数）中除最早日期代表外的记录",
                "无已核验家族证据的日精机台（UNKNOWN 单列待裁定，不进入候选）",
            ],
            "machine_cap": f"单机台最多 {TARGETS_PER_MACHINE} 条（沿用 009 用户批准的 3 台 × 6 张结构）",
            "ordering": f"random.Random({SEED}) 按机台字典序逐台 shuffle（输入按日期+record_id 排序保证确定性），"
                        f"每台取前 {TARGETS_PER_MACHINE} 为目标、其后 {ALTERNATES_PER_MACHINE} 条为候补",
            "post_download_rules": [
                "内容级 SHA-256 去重：候选池内部重复、或与本地校准/遗留图片（S1 校准集、samples_v2 rec02–05）重复，"
                "均按候补固定顺序（rank 升序）替换，不临时人工挑图",
                "状态/质量分层在元数据阶段不可执行（全部 unknown），下载后按预注册口径以候补固定顺序替换不合格项",
            ],
        },
        "targets": targets,
        "alternates": alternates,
        "unknown_pending_decision": [
            {"machine": m, **{k: per_machine[m][k] for k in
                              ("records", "with_attachment", "positions", "date_span")}}
            for m in sorted(machines) if per_machine[m]["family_prescreen"] == "UNKNOWN"
        ],
        "pool_summary": {
            "tact_pool_records": len(pool),
            "per_machine_pool": {m: sum(1 for p in pool if p["machine"] == m)
                                 for m in sorted({p["machine"] for p in pool})},
            "suspected_duplicate_excess_excluded": len(dup_excess_ids),
        },
    }
    CANDIDATES_OUT.write_text(json.dumps(candidates, ensure_ascii=False, indent=2))

    print(f"pool: {len(pool)}  targets: {len(targets)}  alternates: {len(alternates)}")
    print(f"dup groups: {len(dup_groups)}  excess excluded: {len(dup_excess_ids)}")
    print(f"inventory -> {INVENTORY_OUT}")
    print(f"candidates -> {CANDIDATES_OUT}")


def _entry(r, rank):
    ev = VERIFIED_POSITION_FAMILY.get(r["position"])
    return {
        "rank": rank,
        "record_id": r["record_id"],
        "file_token": r["attachment"]["file_token"],
        "machine": r["machine"],
        "position": r["position"],
        "date": r["date"],
        "attachment_size_bytes": r["attachment"]["size"],
        "attachment_type": r["attachment"]["type"],
        "family_evidence": ev[1] if ev else "位置未核验（不应出现在候选中）",
        "status": "unknown_pending_download",
        "quality": "unknown_pending_download",
    }


if __name__ == "__main__":
    sys.exit(main())
