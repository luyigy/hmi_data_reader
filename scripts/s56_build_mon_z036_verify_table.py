"""049_PLAN B2：建飞书「成型监控字段核验-Z036」表并预填 6 行草稿（FANUC）。

克隆 s45 结构。幂等：output/mon_z036_verify_table_records.json 存在即退出。

用法：python3 scripts/s49_build_mon_z036_verify_table.py
"""
import json
import subprocess
import sys
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE_NAME = "成型监控字段核验-Z036"
DRAFTS_DIR = Path("output/mon_z036_drafts")
IMG_DIR = Path("docs/samples_mon_z036")
MAPPING = Path("output/mon_z036_verify_table_records.json")

FIELD_SCHEMA = [
    {"field_name": "图片名", "type": 1},
    {"field_name": "机台", "type": 1},
    {"field_name": "日期", "type": 1},
    {"field_name": "页面变体", "type": 1},
    {"field_name": "原图", "type": 17},
    {"field_name": "草稿_字段", "type": 1},
    {"field_name": "确认_字段", "type": 1},
    {"field_name": "核验状态", "type": 3, "property": {"options": [
        {"name": "待核验", "color": 1}, {"name": "已核验", "color": 0},
        {"name": "有改动", "color": 2}]}},
    {"field_name": "verified_by", "type": 1},
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
    drafts = sorted(DRAFTS_DIR.glob("*.draft.json"))
    assert len(drafts) == 6, f"草稿数 {len(drafts)} != 6"

    d = api("POST", f"/open-apis/bitable/v1/apps/{BASE}/tables",
            data={"table": {"name": TABLE_NAME, "default_view_name": "默认视图",
                            "fields": FIELD_SCHEMA}})
    table_id = d["data"]["table_id"]
    print(f"table created: {table_id}")

    mapping = []
    for p in drafts:
        draft = json.loads(p.read_text())
        img = draft["image"]
        machine, date8, rank = img.split("_")[1:4]
        fields = {
            "图片名": img, "机台": machine,
            "日期": f"{date8[:4]}-{date8[4:6]}-{date8[6:]}",
            "页面变体": draft.get("page_variant", ""),
            "草稿_字段": json.dumps(draft["fields"], ensure_ascii=False),
            "核验状态": "待核验",
            "备注": f"{rank}；大表记录 {draft['source'].get('origin_record_id') or draft['source']['record_id']}",
        }
        r = api("POST", f"/open-apis/bitable/v1/apps/{BASE}/tables/{table_id}/records",
                data={"fields": fields})
        rec_id = r["data"]["record"]["record_id"]
        token = upload_media(IMG_DIR / img)
        api("PUT", f"/open-apis/bitable/v1/apps/{BASE}/tables/{table_id}/records/{rec_id}",
            data={"fields": {"原图": [{"file_token": token}]}})
        mapping.append({"image": img, "record_id": rec_id, "table_id": table_id,
                        "origin_record_id": draft["source"].get("origin_record_id") or draft["source"]["record_id"]})
        print(f"  ok {rank}")
        draft["source"]["table_id"] = table_id
        draft["source"]["record_id"] = rec_id
        p.write_text(json.dumps(draft, ensure_ascii=False, indent=2))

    MAPPING.write_text(json.dumps({
        "base_token": BASE, "table_id": table_id, "table_name": TABLE_NAME,
        "url": f"https://ecn6lj2fknte.feishu.cn/base/{BASE}?table={table_id}",
        "verifier": "自动整批接受（半自动模式，降级；用户保留事后否决权）",
        "records": mapping}, ensure_ascii=False, indent=2))
    print(f"mapping -> {MAPPING}")


if __name__ == "__main__":
    sys.exit(main())
