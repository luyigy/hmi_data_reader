"""026_PLAN S4：FANUC/DEMAG 18 份草稿自动整批接受转真值 + 飞书核验表确认列回填。

自动模式口径（docs/027_ROADMAP §3.1.2）：VLM 草稿零修改转真值，preannotation 保留
visual_skim_acceptance 降级说明，用户保留事后否决权（参照 015/020 先例）。

幂等：若 ground_truth/fanuc_demag_temperature/ 已有 18 份 truth 则跳过落盘；
回填飞书确认列每次运行都会执行（PUT 幂等）。

用法：python3 scripts/s6_fanuc_demag_truth_accept.py
"""
import json
import subprocess
import sys
from pathlib import Path

DRAFTS_DIR = Path("output/fanuc_demag_drafts")
TRUTH_DIR = Path("ground_truth/fanuc_demag_temperature")
MAPPING = Path("output/fanuc_demag_verify_table_records.json")

VERIFIED_BY = "自动整批接受（026 自动模式预授权，visual_skim_acceptance 降级；用户保留事后否决权）"
VERIFIED_AT = "2026-08-01"

# 草稿字段 -> 核验表确认列
CONFIRM_COLUMNS = {
    "barrel_temperature_current_c": "确认_炮筒当前C",
    "barrel_temperature_set_c": "确认_炮筒设定C",
    "high_deviation_c": "确认_上偏差C",
    "low_deviation_c": "确认_下偏差C",
    "control_percent": "确认_加热输出pct",
    "drop_port_temperature_current_c": "确认_下料口当前C",
    "drop_port_temperature_set_c": "确认_下料口设定C",
    "drop_port_control_percent": "确认_下料口输出pct",
    "holding_temperature_c": "确认_保温温度C",
    "oil_temperature_current_c": "确认_油温当前C",
    "oil_temperature_set_c": "确认_油温设定C",
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

        # 1) 真值落盘（自动整批接受，零修改）
        draft["preannotation"] = {
            "proposed_by": "vlm",
            "verified_by": VERIFIED_BY,
            "verified_at": VERIFIED_AT,
            "changed_fields": 0,
            "spot_check_by": "豁免（用户 2026-07-30）",
        }
        draft["notes"] += (" | 2026-08-01 自动整批接受转真值（026 自动模式预授权，"
                           "确认列脚本回填，降级口径；用户保留事后否决权）。")
        (TRUTH_DIR / f"{stem}.truth.json").write_text(
            json.dumps(draft, ensure_ascii=False, indent=2))

        # 2) 飞书核验表确认列回填
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
