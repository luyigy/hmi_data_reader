"""S2：在飞书 Base 内建「S2扩样holdout字段核验」表并预填 18 行 VLM 草稿。

沿用 007 定型流程：草稿列预填 + 确认列留空 + 原图附件，核验人逐字段确认后 diff 回读。
结构克隆自 007 核验表 tblWeLQAYecNONwo，差异：补「油温当前」草稿/确认对（覆盖全部
17 个数值字段），加「机台」「日期」文本列。

走 bot + raw API（typed shortcut 缺细粒度 scope，见 skill lark-base-raw-api）。
幂等：若 output/verify_table_records.json 已存在则直接退出，避免重复建表。

用法：python3 scripts/s2_build_verify_table.py
"""
import json
import subprocess
import sys
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE_NAME = "S2扩样holdout字段核验"
DRAFTS_DIR = Path("output/holdout_drafts")
IMG_DIR = Path("docs/samples_v4_holdout")
MAPPING = Path("output/verify_table_records.json")

FIELD_SCHEMA = [
    {"field_name": "图片名", "type": 1},
    {"field_name": "机台", "type": 1},
    {"field_name": "日期", "type": 1},
    {"field_name": "段数", "type": 2, "property": {"formatter": "0"}},
    {"field_name": "原图", "type": 17},
    {"field_name": "草稿_炮筒设定C", "type": 1},
    {"field_name": "确认_炮筒设定C", "type": 1},
    {"field_name": "草稿_炮筒当前C", "type": 1},
    {"field_name": "确认_炮筒当前C", "type": 1},
    {"field_name": "草稿_油温设定C", "type": 1},
    {"field_name": "确认_油温设定C", "type": 1},
    {"field_name": "草稿_油温当前C", "type": 1},
    {"field_name": "确认_油温当前C", "type": 1},
    {"field_name": "草稿_控制pct", "type": 1},
    {"field_name": "确认_控制pct", "type": 1},
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
        fields = {
            "图片名": img,
            "机台": machine,
            "日期": date,
            "段数": draft["heater_columns"],
            "草稿_炮筒设定C": json.dumps(f["barrel_temperature_set_c"]),
            "草稿_炮筒当前C": json.dumps(f["barrel_temperature_current_c"]),
            "草稿_油温设定C": json.dumps(f["oil_temperature_set_c"]),
            "草稿_油温当前C": json.dumps(f["oil_temperature_current_c"]),
            "草稿_控制pct": json.dumps(f["control_percent"]),
            "核验状态": "待核验",
            "备注": (f"{rank}；大表记录 {draft['source']['origin_record_id']}；"
                   "报警态按用户 2026-07-30 裁定为 normal（红底=加热中指示）；"
                   f"quality={draft.get('quality_grade')}"),
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
        "verifier": "用户本人（2026-07-30 确认）",
        "spot_check": "第二人抽检由用户豁免（2026-07-30）",
        "records": mapping}, ensure_ascii=False, indent=2))
    print(f"mapping -> {MAPPING}")


if __name__ == "__main__":
    main()
