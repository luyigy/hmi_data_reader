"""029_PLAN S3：建飞书「UNKNOWN机台家族裁定」表（32 行：代表图+VLM建议家族+确认列）。

克隆 s5_build_fanuc_demag_verify_table.py 结构。幂等：output/unknown_verify_table_records.json
存在即退出。

用法：python3 scripts/s13_build_unknown_verify_table.py
"""
import json
import subprocess
import sys
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE_NAME = "UNKNOWN机台家族裁定"
DRAFTS = Path("output/unknown_family_drafts.json")
MANIFEST = Path("output/unknown_sample_manifest.json")
IMG_DIR = Path("docs/samples_unknown")
MAPPING = Path("output/unknown_verify_table_records.json")

FIELD_SCHEMA = [
    {"field_name": "机台", "type": 1},
    {"field_name": "名册品牌", "type": 1},
    {"field_name": "位置", "type": 1},
    {"field_name": "代表图", "type": 17},
    {"field_name": "代表图日期", "type": 1},
    {"field_name": "VLM建议家族", "type": 3, "property": {"options": [
        {"name": "KEBA", "color": 0}, {"name": "B_AND_R", "color": 1},
        {"name": "TACT", "color": 2}, {"name": "FANUC", "color": 3},
        {"name": "DEMAG", "color": 4}, {"name": "ZIZES", "color": 5},
        {"name": "OTHER", "color": 6}, {"name": "无法判定", "color": 7}]}},
    {"field_name": "VLM证据", "type": 1},
    {"field_name": "确认家族", "type": 3, "property": {"options": [
        {"name": "KEBA", "color": 0}, {"name": "B_AND_R", "color": 1},
        {"name": "TACT", "color": 2}, {"name": "FANUC", "color": 3},
        {"name": "DEMAG", "color": 4}, {"name": "ZIZES", "color": 5},
        {"name": "OTHER", "color": 6}, {"name": "无法判定", "color": 7}]}},
    {"field_name": "核验状态", "type": 3, "property": {"options": [
        {"name": "待核验", "color": 1}, {"name": "已核验", "color": 0},
        {"name": "有改动", "color": 2}]}},
    {"field_name": "备注", "type": 1},
]


def api(method, path, **kwargs):
    cmd = ["lark-cli", "api", method, path, "--as", "bot"]
    if "params" in kwargs:
        cmd += ["--params", json.dumps(kwargs["params"], ensure_ascii=False)]
    if "data" in kwargs:
        cmd += ["--data", json.dumps(kwargs["data"], ensure_ascii=False)]
    if "file" in kwargs:
        cmd += ["--file", kwargs["file"]]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"{method} {path} failed: {res.stderr or res.stdout[:2000]}")
    return json.loads(res.stdout)


def upload_media(path: Path) -> str:
    d = api("POST", "/open-apis/drive/v1/medias/upload_all",
            file=f"file={path}",
            data={"file_name": path.name, "parent_type": "bitable_file",
                  "parent_node": BASE, "size": path.stat().st_size})
    return d["data"]["file_token"]


def main():
    if MAPPING.exists():
        sys.exit(f"{MAPPING} 已存在，退出避免重复建表。")
    drafts = json.loads(DRAFTS.read_text())
    samples = json.loads(MANIFEST.read_text())["samples"]
    assert len(samples) == 32 and len(drafts) == 32

    d = api("POST", f"/open-apis/bitable/v1/apps/{BASE}/tables",
            data={"table": {"name": TABLE_NAME, "default_view_name": "默认视图",
                            "fields": FIELD_SCHEMA}})
    table_id = d["data"]["table_id"]
    print(f"table created: {table_id}")

    mapping = []
    for s in samples:
        key = f"{s['brand']}/{s['machine']}"
        fam, evidence = drafts[key]
        fields = {
            "机台": s["machine"],
            "名册品牌": s["brand"],
            "位置": str(s.get("position") or ""),
            "代表图日期": s["date"],
            "VLM建议家族": fam,
            "VLM证据": evidence,
            "核验状态": "待核验",
            "备注": f"大表记录 {s['record_id']}；原名册无家族证据，029 S2 VLM 判族",
        }
        r = api("POST", f"/open-apis/bitable/v1/apps/{BASE}/tables/{table_id}/records",
                data={"fields": fields})
        rec_id = r["data"]["record"]["record_id"]
        token = upload_media(IMG_DIR / s["local_name"])
        api("PUT", f"/open-apis/bitable/v1/apps/{BASE}/tables/{table_id}/records/{rec_id}",
            data={"fields": {"代表图": [{"file_token": token}]}})
        mapping.append({"machine": key, "record_id": rec_id, "table_id": table_id,
                        "suggested": fam, "local_name": s["local_name"]})
        print(f"  ok {key} -> {fam}")

    MAPPING.write_text(json.dumps({
        "base_token": BASE, "table_id": table_id, "table_name": TABLE_NAME,
        "url": f"https://ecn6lj2fknte.feishu.cn/base/{BASE}?table={table_id}",
        "records": mapping}, ensure_ascii=False, indent=2))
    print(f"mapping -> {MAPPING}")


if __name__ == "__main__":
    sys.exit(main())
