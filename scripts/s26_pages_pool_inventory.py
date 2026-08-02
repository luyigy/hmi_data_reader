"""039 续推：其余 5 条页面线附件分布只读盘点（不下载附件）。

字段：储料/冷却、成型监控一/二、波形图、热流道温控箱温度、模温机前模、模温机后模。
按品牌×机台聚合（记录数/含附件数/附件总数/日期跨度）。
产物 output/pages_pool_inventory.json。

用法：python3 scripts/s26_pages_pool_inventory.py
"""
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE = "tbl5KKYuANqGpycE"
FIELDS = ["成型条件-储料/冷却", "成型条件-成型监控一/二", "成型条件-波形图",
          "成型条件-热流道温控箱温度", "成型条件-模温机前模", "成型条件-模温机后模"]
TZ_CN = timezone(timedelta(hours=8))
OUT = Path("output/pages_pool_inventory.json")


def search_all():
    body = {"field_names": ["品牌", "注塑机ID", "日期"] + FIELDS}
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
    agg = defaultdict(lambda: {"records": 0, "dates": set(),
                               **{f: 0 for f in FIELDS}})
    for it in items:
        f = it["fields"]
        brand = str((f.get("品牌") or ["?"])[0] if isinstance(f.get("品牌"), list) else f.get("品牌") or "?")
        mid = str((f.get("注塑机ID") or ["?"])[0] if isinstance(f.get("注塑机ID"), list) else f.get("注塑机ID") or "?")
        a = agg[f"{brand}/{mid}"]
        a["records"] += 1
        d = f.get("日期")
        if isinstance(d, (int, float)):
            a["dates"].add(datetime.fromtimestamp(d / 1000, tz=TZ_CN).strftime("%Y-%m-%d"))
        for fld in FIELDS:
            a[fld] += len(f.get(fld) or [])

    per_field = {}
    for fld in FIELDS:
        machines = {k: v[fld] for k, v in agg.items() if v[fld] > 0}
        per_field[fld] = {
            "machines_with_attachment": len(machines),
            "attachments_total": sum(machines.values()),
            "top_machines": dict(sorted(machines.items(), key=lambda kv: -kv[1])[:8]),
        }
    OUT.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "kimi-code 039 续推（环境已恢复）",
        "access": "bot + raw API 只读，未下载任何附件",
        "per_field": per_field,
    }, ensure_ascii=False, indent=2))
    for fld in FIELDS:
        p = per_field[fld]
        print(f"{fld}: {p['machines_with_attachment']} 台 / {p['attachments_total']} 附件")
    print(f"-> {OUT}")


if __name__ == "__main__":
    sys.exit(main())
