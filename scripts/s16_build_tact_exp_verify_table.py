"""031_PLAN S3：建飞书「TACT扩样字段核验」表并预填 18 行草稿。

克隆 s5_build_fanuc_demag_verify_table.py。幂等：output/tact_exp_verify_table_records.json
存在即退出。

用法：python3 scripts/s16_build_tact_exp_verify_table.py
"""
import json
import subprocess
import sys
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE_NAME = "TACT扩样字段核验"
DRAFTS_DIR = Path("output/tact_exp_drafts")
IMG_DIR = Path("docs/samples_tact_exp")
MAPPING = Path("output/tact_exp_verify_table_records.json")

FIELD_SCHEMA = [
    {"field_name": "图片名", "type": 1},
    {"field_name": "机台", "type": 1},
    {"field_name": "日期", "type": 1},
    {"field_name": "段数", "type": 2, "property": {"formatter": "0"}},
    {"field_name": "原图", "type": 17},
    {"field_name": "草稿_炮筒当前C", "type": 1},
    {"field_name": "确认_炮筒当前C", "type": 1},
    {"field_name": "草稿_炮筒设定C", "type": 1},
    {"field_name": "确认_炮筒设定C", "type": 1},
    {"field_name": "草稿_控制输出pct", "type": 1},
    {"field_name": "确认_控制输出pct", "type": 1},
    {"field_name": "草稿_保温温度C", "type": 1},
    {"field_name": "确认_保温温度C", "type": 1},
    {"field_name": "草稿_落下口设定C", "type": 1},
    {"field_name": "确认_落下口设定C", "type": 1},
    {"field_name": "草稿_落下口当前C", "type": 1},
    {"field_name": "确认_落下口当前C", "type": 1},
    {"field_name": "草稿_报警状态", "type": 1},
    {"field_name": "确认_报警状态", "type": 1},
    {"field_name": "核验状态", "type": 3, "property": {"options": [
        {"name": "待核验", "color": 1}, {"name": "已核验", "color": 0},
        {"name": "有改动", "color": 2}]}},
    {"field_name": "verified_by", "type": 1},
    {"field_name": "备注", "type": 1},
]

RANK_FLAGS = {
    "rank09": "保温温度中部/后部反光置空",
    "rank23": "候补补位：原 rank10 为 TRD6 沙迪克屏（家族不一致剔除）",
}


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
    assert len(drafts) == 18, f"草稿数 {len(drafts)} != 18"

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
        date = f"{date8[:4]}-{date8[4:6]}-{date8[6:]}"
        f = draft["fields"]
        note = f"{rank}；大表记录 {draft['source']['origin_record_id']}"
        if rank in RANK_FLAGS:
            note += f"；{RANK_FLAGS[rank]}"
        fields = {
            "图片名": img, "机台": machine, "日期": date,
            "段数": draft["heater_columns"],
            "草稿_炮筒当前C": json.dumps(f["barrel_temperature_current_c"]),
            "草稿_炮筒设定C": json.dumps(f["barrel_temperature_set_c"]),
            "草稿_控制输出pct": json.dumps(f.get("control_percent")),
            "草稿_保温温度C": json.dumps(f.get("holding_temperature_c")),
            "草稿_落下口设定C": json.dumps(f.get("drop_port_temperature_set_c")),
            "草稿_落下口当前C": json.dumps(f.get("drop_port_temperature_current_c")),
            "草稿_报警状态": draft.get("alarm_status"),
            "核验状态": "待核验", "备注": note,
        }
        r = api("POST", f"/open-apis/bitable/v1/apps/{BASE}/tables/{table_id}/records",
                data={"fields": fields})
        rec_id = r["data"]["record"]["record_id"]
        token = upload_media(IMG_DIR / img)
        api("PUT", f"/open-apis/bitable/v1/apps/{BASE}/tables/{table_id}/records/{rec_id}",
            data={"fields": {"原图": [{"file_token": token}]}})
        mapping.append({"image": img, "record_id": rec_id, "table_id": table_id,
                        "origin_record_id": draft["source"]["origin_record_id"]})
        print(f"  ok {rank} {machine}")
        draft["source"]["table_id"] = table_id
        draft["source"]["record_id"] = rec_id
        p.write_text(json.dumps(draft, ensure_ascii=False, indent=2))

    MAPPING.write_text(json.dumps({
        "base_token": BASE, "table_id": table_id, "table_name": TABLE_NAME,
        "url": f"https://ecn6lj2fknte.feishu.cn/base/{BASE}?table={table_id}",
        "verifier": "自动整批接受（027 自动模式预授权，降级；用户保留事后否决权）",
        "records": mapping}, ensure_ascii=False, indent=2))
    print(f"mapping -> {MAPPING}")


if __name__ == "__main__":
    sys.exit(main())
