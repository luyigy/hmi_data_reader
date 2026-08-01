"""031_PLAN S1：TACT 第一波扩样候选清单（Z015/Z019/Z025 各 6 目标+4 候补）。

克隆 s3/s4 盘点逻辑：大表只读 search（品牌=日精、注塑机ID∈三机台、含炮筒温度附件），
同机台同字节数去重（留最早），random.Random(SEED) 机台内 shuffle。
状态 PENDING_USER_APPROVAL，批准前禁止下载。

用法：python3 scripts/s14_tact_exp_candidates.py
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
ATTACH_FIELD = "成型条件-炮筒温度设定"
FIELD_NAMES = ["品牌", "注塑机ID", "位置编号", "日期", ATTACH_FIELD]
MACHINES = ["Z015", "Z019", "Z025"]
SEED = 20260801
TARGETS, ALTERNATES = 6, 4
TZ_CN = timezone(timedelta(hours=8))
OUT = Path("output/tact_exp_candidates.json")


def search_all(machine):
    body = {
        "field_names": FIELD_NAMES,
        "filter": {"conjunction": "and", "conditions": [
            {"field_name": "品牌", "operator": "contains", "value": ["日精"]},
            {"field_name": "注塑机ID", "operator": "is", "value": [machine]}]},
    }
    res = subprocess.run([
        "lark-cli", "api", "POST",
        f"/open-apis/bitable/v1/apps/{BASE}/tables/{TABLE}/records/search",
        "--as", "bot",
        "--params", json.dumps({"page_size": 500}),
        "--data", json.dumps(body, ensure_ascii=False),
        "--page-all", "--page-limit", "0", "--json",
    ], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"search failed {machine}: {res.stderr or res.stdout[:2000]}")
    return json.loads(res.stdout)["data"]["items"]


def parse(item):
    f = item["fields"]
    date_ms = f.get("日期")
    atts = f.get(ATTACH_FIELD) or []
    att = atts[0] if atts else None
    return {
        "record_id": item["record_id"],
        "position": str((f.get("位置编号") or [""])[0] if isinstance(f.get("位置编号"), list) else f.get("位置编号") or ""),
        "date": (datetime.fromtimestamp(date_ms / 1000, tz=TZ_CN).strftime("%Y-%m-%d")
                 if isinstance(date_ms, (int, float)) else None),
        "attachment": ({"file_token": att.get("file_token"), "size": att.get("size"),
                        "type": att.get("type")} if att else None),
    }


def main():
    rng = random.Random(SEED)
    targets, alternates, pool_summary = [], [], {}
    rank = 1
    picks = {}
    for m in MACHINES:
        recs = [parse(i) for i in search_all(m)]
        recs = [r for r in recs if r["attachment"]]
        by_size = defaultdict(list)
        for r in recs:
            by_size[r["attachment"]["size"]].append(r)
        pool = []
        for size, group in by_size.items():
            group.sort(key=lambda r: (r["date"] or "9999", r["record_id"]))
            pool.append(group[0])
        pool.sort(key=lambda r: (r["date"] or "9999", r["record_id"]))
        rng.shuffle(pool)
        picks[m] = (pool[:TARGETS], pool[TARGETS:TARGETS + ALTERNATES])
        pool_summary[m] = {"records_with_att": len(recs), "pool_after_dedup": len(pool)}
        print(f"{m}: 附件 {len(recs)} 去重后 {len(pool)}")
    for m in MACHINES:
        for e in picks[m][0]:
            targets.append({"rank": rank, "machine": m, "brand": "日精", "family": "TACT", **e,
                            "status": "unknown_pending_download"})
            rank += 1
    for m in MACHINES:
        for e in picks[m][1]:
            alternates.append({"rank": rank, "machine": m, "brand": "日精", "family": "TACT", **e,
                               "status": "unknown_pending_download"})
            rank += 1
    OUT.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "kimi-code S1 (031_PLAN)",
        "status": "PENDING_USER_APPROVAL",
        "selection_spec": {"random_seed": SEED,
                           "pool": "日精 Z015/Z019/Z025 含炮筒温度附件记录（029 裁定 TACT）",
                           "machine_cap": "每台 6 目标 + 4 候补（009 批准结构）"},
        "pool_summary": pool_summary,
        "targets": targets, "alternates": alternates,
    }, ensure_ascii=False, indent=2))
    print(f"targets {len(targets)} alternates {len(alternates)} -> {OUT}")


if __name__ == "__main__":
    sys.exit(main())
