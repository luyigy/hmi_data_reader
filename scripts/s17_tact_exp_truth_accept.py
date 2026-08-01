"""031_PLAN S4：TACT 扩样 18 份草稿自动整批接受转真值 + 核验表确认列回填。

克隆 s6_fanuc_demag_truth_accept.py（027 自动模式降级口径：visual_skim_acceptance +
用户事后否决权）。真值目录 ground_truth/tact_exp_temperature/。

用法：python3 scripts/s17_tact_exp_truth_accept.py
"""
import json
import subprocess
import sys
from pathlib import Path

DRAFTS_DIR = Path("output/tact_exp_drafts")
TRUTH_DIR = Path("ground_truth/tact_exp_temperature")
MAPPING = Path("output/tact_exp_verify_table_records.json")

VERIFIED_BY = "自动整批接受（027 自动模式预授权，visual_skim_acceptance 降级；用户保留事后否决权）"
VERIFIED_AT = "2026-08-01"

CONFIRM_COLUMNS = {
    "barrel_temperature_current_c": "确认_炮筒当前C",
    "barrel_temperature_set_c": "确认_炮筒设定C",
    "control_percent": "确认_控制输出pct",
    "holding_temperature_c": "确认_保温温度C",
    "drop_port_temperature_set_c": "确认_落下口设定C",
    "drop_port_temperature_current_c": "确认_落下口当前C",
}


def api(method, path, **kwargs):
    cmd = ["lark-cli", "api", method, path, "--as", "bot"]
    if "params" in kwargs:
        cmd += ["--params", json.dumps(kwargs["params"], ensure_ascii=False)]
    if "data" in kwargs:
        cmd += ["--data", json.dumps(kwargs["data"], ensure_ascii=False)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"{method} {path} failed: {res.stderr or res.stdout}")
    return json.loads(res.stdout)


def main():
    mapping = json.loads(MAPPING.read_text())
    base, table_id = mapping["base_token"], mapping["table_id"]
    rec_of = {m["image"]: m["record_id"] for m in mapping["records"]}

    drafts = sorted(DRAFTS_DIR.glob("*.draft.json"))
    assert len(drafts) == 18, f"草稿数 {len(drafts)} != 18"
    TRUTH_DIR.mkdir(parents=True, exist_ok=True)

    for p in drafts:
        draft = json.loads(p.read_text())
        img = draft["image"]
        stem = Path(img).stem
        draft["preannotation"] = {
            "proposed_by": "vlm", "verified_by": VERIFIED_BY,
            "verified_at": VERIFIED_AT, "changed_fields": 0,
            "spot_check_by": "豁免（用户 2026-07-30）",
        }
        draft["notes"] += " | 2026-08-01 自动整批接受转真值（降级口径；用户保留事后否决权）。"
        (TRUTH_DIR / f"{stem}.truth.json").write_text(
            json.dumps(draft, ensure_ascii=False, indent=2))

        f = draft["fields"]
        fields = {col: json.dumps(f.get(k)) for k, col in CONFIRM_COLUMNS.items()}
        fields["确认_报警状态"] = draft.get("alarm_status")
        fields["核验状态"] = "已核验"
        fields["verified_by"] = VERIFIED_BY
        api("PUT", f"/open-apis/bitable/v1/apps/{base}/tables/{table_id}/records/{rec_of[img]}",
            data={"fields": fields})
        print(f"  ok {stem}")

    print(f"truth x18 -> {TRUTH_DIR}; 核验表 18 行确认列已回填")


if __name__ == "__main__":
    sys.exit(main())
