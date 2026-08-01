"""013_PLAN S3：在飞书 Base 内建「伯乐温度页字段核验」表并预填 20 行 VLM 草稿。

克隆自 scripts/s3_build_tact_verify_table.py（013 S2 TACT），差异：
- 草稿 `output/bole_drafts/`×20、原图 `docs/samples_bole/`；
- KEBA 与 B_AND_R 共用一张表，字段取并集：炮筒当前/设定、法兰当前（KEBA）、
  上/下偏差、加热输出pct（B_AND_R）、保温温度、油温当前（KEBA Z001 部分）；
  不适用字段留空（如 B_AND_R 无法兰/油温，KEBA 无加热输出）。

走 bot + raw API。幂等：若 output/bole_verify_table_records.json 已存在则直接退出。

用法：python3 scripts/s4_build_bole_verify_table.py
"""
import json
import subprocess
import sys
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE_NAME = "伯乐温度页字段核验"
DRAFTS_DIR = Path("output/bole_drafts")
IMG_DIR = Path("docs/samples_bole")
MAPPING = Path("output/bole_verify_table_records.json")

FIELD_SCHEMA = [
    {"field_name": "图片名", "type": 1},
    {"field_name": "机台", "type": 1},
    {"field_name": "家族", "type": 1},
    {"field_name": "日期", "type": 1},
    {"field_name": "段数", "type": 2, "property": {"formatter": "0"}},
    {"field_name": "原图", "type": 17},
    {"field_name": "草稿_炮筒当前C", "type": 1},
    {"field_name": "确认_炮筒当前C", "type": 1},
    {"field_name": "草稿_炮筒设定C", "type": 1},
    {"field_name": "确认_炮筒设定C", "type": 1},
    {"field_name": "草稿_法兰当前C", "type": 1},
    {"field_name": "确认_法兰当前C", "type": 1},
    {"field_name": "草稿_上偏差C", "type": 1},
    {"field_name": "确认_上偏差C", "type": 1},
    {"field_name": "草稿_下偏差C", "type": 1},
    {"field_name": "确认_下偏差C", "type": 1},
    {"field_name": "草稿_加热输出pct", "type": 1},
    {"field_name": "确认_加热输出pct", "type": 1},
    {"field_name": "草稿_保温温度C", "type": 1},
    {"field_name": "确认_保温温度C", "type": 1},
    {"field_name": "草稿_油温当前C", "type": 1},
    {"field_name": "确认_油温当前C", "type": 1},
    {"field_name": "草稿_报警状态", "type": 1},
    {"field_name": "确认_报警状态", "type": 1},
    {"field_name": "核验状态", "type": 3, "property": {"options": [
        {"name": "待核验", "color": 1}, {"name": "已核验", "color": 0},
        {"name": "有改动", "color": 2}]}},
    {"field_name": "verified_by", "type": 1},
    {"field_name": "备注", "type": 1},
]

RANK_FLAGS = {
    "rank02": "720p小图斜拍，油温区出画置空",
    "rank03": "斜拍右侧模糊，保温/油温置空；加热段已裁切复核",
    "rank06": "油温区反光模糊置空；z1/z4 升温中",
    "rank07": "Z004 经你 2026-07-31 裁定为 B_AND_R，作为 B_AND_R 第 7 张",
    "rank11": "保温温度未入镜置空",
    "rank16": "真实报警态：z1 喷嘴段「---」热电偶故障，z1 各字段置空，应禁止自动入库",
    "rank18": "保温温度 180（其他 Z047 图多为 150），已读图确认",
    "rank19": "保温温度 180 同 rank18",
    "rank20": "候替补位（顶替 Z004 原 KEBA 名额）；油温区模糊置空",
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
        raise RuntimeError(f"{method} {path} failed: {res.stderr or res.stdout}")
    return json.loads(res.stdout)


def upload_media(path: Path) -> str:
    d = api("POST", "/open-apis/drive/v1/medias/upload_all",
            file=f"file={path}",
            data={"file_name": path.name, "parent_type": "bitable_file",
                  "parent_node": BASE, "size": path.stat().st_size})
    return d["data"]["file_token"]


def main():
    if MAPPING.exists():
        sys.exit(f"{MAPPING} 已存在，疑似已建表，退出避免重复。删除该文件以重建。")

    drafts = sorted(DRAFTS_DIR.glob("*.draft.json"))
    assert len(drafts) == 20, f"草稿数 {len(drafts)} != 20"

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
        note = (f"{rank}；大表记录 {draft['source']['origin_record_id']}；"
                f"quality={draft.get('quality_grade')}")
        if rank in RANK_FLAGS:
            note += f"；{RANK_FLAGS[rank]}"
        fields = {
            "图片名": img,
            "机台": machine,
            "家族": draft["controller_family"],
            "日期": date,
            "段数": draft["heater_columns"],
            "草稿_炮筒当前C": json.dumps(f["barrel_temperature_current_c"]),
            "草稿_炮筒设定C": json.dumps(f["barrel_temperature_set_c"]),
            "草稿_法兰当前C": json.dumps(f.get("flange_temperature_current_c")),
            "草稿_上偏差C": json.dumps(f.get("high_deviation_c")),
            "草稿_下偏差C": json.dumps(f.get("low_deviation_c")),
            "草稿_加热输出pct": json.dumps(f.get("control_percent")),
            "草稿_保温温度C": json.dumps(f.get("holding_temperature_c")),
            "草稿_油温当前C": json.dumps(f.get("oil_temperature_current_c")),
            "草稿_报警状态": draft.get("alarm_status"),
            "核验状态": "待核验",
            "备注": note,
        }
        r = api("POST", f"/open-apis/bitable/v1/apps/{BASE}/tables/{table_id}/records",
                data={"fields": fields})
        rec_id = r["data"]["record"]["record_id"]
        token = upload_media(IMG_DIR / img)
        api("PUT", f"/open-apis/bitable/v1/apps/{BASE}/tables/{table_id}/records/{rec_id}",
            data={"fields": {"原图": [{"file_token": token}]}})
        mapping.append({"image": img, "record_id": rec_id, "table_id": table_id,
                        "origin_record_id": draft["source"]["origin_record_id"]})
        print(f"  ok {rank} {machine} rec={rec_id}")

        # 回写草稿 source，保持可回溯
        draft["source"]["table_id"] = table_id
        draft["source"]["record_id"] = rec_id
        p.write_text(json.dumps(draft, ensure_ascii=False, indent=2))

    MAPPING.write_text(json.dumps({
        "base_token": BASE, "table_id": table_id, "table_name": TABLE_NAME,
        "url": f"https://ecn6lj2fknte.feishu.cn/base/{BASE}?table={table_id}",
        "verifier": "用户本人（沿用 2026-07-30 简化口径，降级）",
        "spot_check": "第二人抽检由用户豁免（2026-07-30）",
        "records": mapping}, ensure_ascii=False, indent=2))
    print(f"mapping -> {MAPPING}")


if __name__ == "__main__":
    main()
