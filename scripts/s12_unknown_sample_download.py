"""029_PLAN S1：UNKNOWN 机台每台下载 1 张代表图（最新带附件记录）。

伯乐 17 + 日精 12 + 发那科 3 = 32 台（以三份候选清单 unknown_pending_decision 为准）。
产物：docs/samples_unknown/ + output/unknown_sample_manifest.json。

用法：python3 scripts/s12_unknown_sample_download.py
"""
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE = "tbl5KKYuANqGpycE"
ATTACH_FIELD = "成型条件-炮筒温度设定"
OUT_DIR = Path("docs/samples_unknown")
MANIFEST = Path("output/unknown_sample_manifest.json")
TZ_CN = timezone(timedelta(hours=8))

MACHINES = {
    "伯乐": ["Z007", "Z010", "Z023", "Z029", "Z031", "Z034", "Z038", "Z048", "Z049",
             "Z050", "Z053", "Z055", "Z056", "Z057", "Z058", "Z059", "Z061"],
    "日精": ["Z003", "Z008", "Z009", "Z011", "Z012", "Z014", "Z015", "Z016", "Z019",
             "Z025", "Z077", "Z078"],
    "发那科": ["Z027", "Z035", "Z036"],
}


def api(method, path, **kwargs):
    cmd = ["lark-cli", "api", method, path, "--as", "bot"]
    if "params" in kwargs:
        cmd += ["--params", json.dumps(kwargs["params"], ensure_ascii=False)]
    if "data" in kwargs:
        cmd += ["--data", json.dumps(kwargs["data"], ensure_ascii=False)]
    if "output" in kwargs:
        cmd += ["-o", kwargs["output"]]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"{method} {path} failed: {res.stderr or res.stdout[:2000]}")
    if "output" in kwargs:
        return None
    return json.loads(res.stdout)


def latest_with_attachment(brand, machine):
    body = {
        "field_names": ["品牌", "注塑机ID", "位置编号", "日期", ATTACH_FIELD],
        "filter": {"conjunction": "and", "conditions": [
            {"field_name": "品牌", "operator": "contains", "value": [brand]},
            {"field_name": "注塑机ID", "operator": "is", "value": [machine]}]},
    }
    d = api("POST", f"/open-apis/bitable/v1/apps/{BASE}/tables/{TABLE}/records/search",
            params={"page_size": 500}, data=body)
    best = None
    for item in d["data"].get("items", []):
        f = item["fields"]
        atts = f.get(ATTACH_FIELD) or []
        if not atts:
            continue
        date_ms = f.get("日期") or 0
        if best is None or date_ms > best[0]:
            best = (date_ms, item["record_id"], atts[0], f.get("位置编号"), date_ms)
    return best


def download(file_token, out_path: Path):
    extra = json.dumps({"bitablePerm": {"tableId": TABLE, "rev": 0}}, separators=(",", ":"))
    tmp = out_path.with_suffix(".tmp")
    try:
        api("GET", f"/open-apis/drive/v1/medias/{file_token}/download",
            params={"extra": extra}, output=str(tmp))
        if not tmp.exists() or tmp.stat().st_size == 0:
            raise RuntimeError("empty download")
        tmp.rename(out_path)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"  ERROR {out_path.name}: {e}", file=sys.stderr)
        tmp.unlink(missing_ok=True)
        return False


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "generator": "kimi-code S1 (029_PLAN)", "samples": [], "errors": []}
    for brand, machines in MACHINES.items():
        for m in machines:
            r = latest_with_attachment(brand, m)
            if not r:
                manifest["errors"].append({"brand": brand, "machine": m,
                                           "reason": "无带附件记录"})
                print(f"  !! {brand}/{m} 无带附件记录")
                continue
            date_ms, rec_id, att, pos, _ = r
            date = (datetime.fromtimestamp(date_ms / 1000, tz=TZ_CN).strftime("%Y%m%d")
                    if date_ms else "unknown")
            name = f"unknown_{brand}_{m}_{date}_{rec_id}.jpeg"
            print(f"{brand}/{m} (位置{pos}) {date} ...")
            if download(att["file_token"], OUT_DIR / name):
                manifest["samples"].append({
                    "brand": brand, "machine": m, "position": pos, "date": date,
                    "record_id": rec_id, "file_token": att["file_token"],
                    "local_name": name})
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"\nsamples: {len(manifest['samples'])}/32, errors: {len(manifest['errors'])}")
    print(f"manifest -> {MANIFEST}")


if __name__ == "__main__":
    sys.exit(main())
