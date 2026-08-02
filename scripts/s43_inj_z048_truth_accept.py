"""049_PLAN A5：Z048 EST 射保 6 份草稿自动整批接受转真值 + 核验表确认列回填。

克隆 s17 口径（自动整批接受降级 + 用户事后否决权）。核验表为通用列结构
（草稿_字段/确认_字段 文本列，s30 建），自动接受 = 确认列与草稿列一致、changed_fields=0。
真值目录 ground_truth/inj_z048_injection/。

用法：python3 scripts/s43_inj_z048_truth_accept.py
"""
import json
import subprocess
import sys
from pathlib import Path

DRAFTS_DIR = Path("output/inj_z048_drafts")
TRUTH_DIR = Path("ground_truth/inj_z048_injection")
MAPPING = Path("output/inj_z048_verify_table_records.json")

VERIFIED_BY = "自动整批接受（049 全自动接力口径，visual_skim_acceptance 降级；用户保留事后否决权）"
VERIFIED_AT = "2026-08-02"


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
    assert len(drafts) == 6, f"草稿数 {len(drafts)} != 6"
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
        draft["notes"] += " | 2026-08-02 自动整批接受转真值（049 全自动口径；用户保留事后否决权）。"
        (TRUTH_DIR / f"{stem}.truth.json").write_text(
            json.dumps(draft, ensure_ascii=False, indent=2))

        api("PUT", f"/open-apis/bitable/v1/apps/{base}/tables/{table_id}/records/{rec_of[img]}",
            data={"fields": {
                "确认_字段": json.dumps(draft["fields"], ensure_ascii=False),
                "核验状态": "已核验",
                "verified_by": VERIFIED_BY,
            }})
        print(f"  ok {stem}")

    print(f"truth x6 -> {TRUTH_DIR}; 核验表 6 行确认列已回填")


if __name__ == "__main__":
    sys.exit(main())
