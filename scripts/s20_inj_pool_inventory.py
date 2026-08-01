"""035_PLAN S1：「成型条件-射出/保压」附件分布只读盘点（不下载任何附件）。

按品牌×机台聚合：记录数、含附件数、附件总数、日期跨度。
产物 output/inj_pool_inventory.json。

用法：python3 scripts/s20_inj_pool_inventory.py
"""
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE = "tbl5KKYuANqGpycE"
ATTACH_FIELD = "成型条件-射出/保压"
TZ_CN = timezone(timedelta(hours=8))
OUT = Path("output/inj_pool_inventory.json")


def search_all():
    body = {"field_names": ["品牌", "注塑机ID", "位置编号", "日期", ATTACH_FIELD]}
    res = subprocess.run([
        "lark-cli", "api", "POST",
        f"/open-apis/bitable/v1/apps/{BASE}/tables/{TABLE}/records/search",
        "--as", "bot",
        "--params", json.dumps({"page_size": 500}),
        "--data", json.dumps(body, ensure_ascii=False),
        "--page-all", "--page-limit", "0", "--json",
    ], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"search failed: {res.stderr or res.stdout[:2000]}")
    return json.loads(res.stdout)["data"]["items"]


def main():
    items = search_all()
    print(f"records scanned: {len(items)}")
    agg = defaultdict(lambda: {"records": 0, "with_attachment": 0, "attachments": 0,
                               "dates": set(), "positions": set()})
    for it in items:
        f = it["fields"]
        brand = str((f.get("品牌") or ["?"])[0] if isinstance(f.get("品牌"), list) else f.get("品牌") or "?")
        mid = str((f.get("注塑机ID") or ["?"])[0] if isinstance(f.get("注塑机ID"), list) else f.get("注塑机ID") or "?")
        key = f"{brand}/{mid}"
        a = agg[key]
        a["records"] += 1
        atts = f.get(ATTACH_FIELD) or []
        if atts:
            a["with_attachment"] += 1
            a["attachments"] += len(atts)
        d = f.get("日期")
        if isinstance(d, (int, float)):
            a["dates"].add(datetime.fromtimestamp(d / 1000, tz=TZ_CN).strftime("%Y-%m-%d"))
        pos = f.get("位置编号")
        if pos:
            a["positions"].add(str(pos[0] if isinstance(pos, list) else pos))

    per_machine = {}
    for k, a in sorted(agg.items()):
        dates = sorted(a["dates"])
        per_machine[k] = {
            "records": a["records"],
            "with_attachment": a["with_attachment"],
            "attachments": a["attachments"],
            "positions": sorted(a["positions"]),
            "date_span": [dates[0], dates[-1]] if dates else None,
        }
    have = {k: v for k, v in per_machine.items() if v["with_attachment"] > 0}
    OUT.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "kimi-code S1 (035_PLAN)",
        "attach_field": ATTACH_FIELD,
        "access": "bot + raw API 只读，未下载任何附件",
        "totals": {
            "machines_total": len(per_machine),
            "machines_with_attachment": len(have),
            "attachments_total": sum(v["attachments"] for v in have.values()),
        },
        "per_machine_with_attachment": dict(sorted(
            have.items(), key=lambda kv: -kv[1]["attachments"])),
    }, ensure_ascii=False, indent=2))
    print(f"machines with {ATTACH_FIELD}: {len(have)}/{len(per_machine)}")
    for k, v in list(sorted(have.items(), key=lambda kv: -kv[1]["attachments"]))[:15]:
        print(f"  {k}: {v['with_attachment']} 条 / {v['attachments']} 附件 {v['date_span']}")
    print(f"-> {OUT}")


if __name__ == "__main__":
    sys.exit(main())
