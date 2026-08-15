"""054 PLAN S01：由大模型视觉真值（vision.json）构建 datasets/holdout 契约真值。

- 每条 case：复制图片到 datasets/holdout/<profile_id>/<case_id>.<ext> 并写 truth.yml；
- profile 归置：正例进本 Profile 目录；未注册布局的负例进其所验收的 Profile 目录
  （profile_id 必须在注册表内，allow_auto_import=false 钉住安全拒识），与既有
  calibration 负例约定一致；
- 幂等：已存在的 case 重写为同内容（truth 由 vision.json 唯一决定）。

用法：
    .venv/bin/python scripts/s054_build_holdout.py --batch-id batch_001
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]

# layout -> (profile_id, 是否正例)；未注册布局负例归入所验收 Profile 目录
LAYOUT_PROFILE = {
    "screen_order_5": ("demag.temperature.screen_order_5", True),
    "zizes_7zone": ("demag.temperature.screen_order_5", False),
    "trd6_z0z6": ("demag.temperature.screen_order_5", False),
    "arburg_6zone": ("demag.temperature.screen_order_5", False),
    "tact_temp_6zone": ("demag.temperature.screen_order_5", False),
    "keba_dynamic": ("b_and_r.temperature.fixed", False),
    "b_and_r_fixed": ("b_and_r.temperature.fixed", True),
    "fanuc_rightmost5": ("fanuc.temperature.rightmost5", True),
    "digital_sv": ("tact.hot_runner_temp.digital_sv", True),
    "yudo_cw301": ("tact.hot_runner_temp.digital_sv", False),
    "pv_sv_decimal": ("mold_thermoregulator.mold_temp.pv_sv_decimal", True),
    "hangrui_lcd_front": ("mold_thermoregulator.mold_temp.pv_sv_decimal", False),
    "single_loop": ("omron_e5cc.mold_temp.single_loop", True),
    "hangrui_lcd_rear": ("omron_e5cc.mold_temp.single_loop", False),
    "mt_quality_unreadable": ("omron_e5cc.mold_temp.single_loop", False),
    "lcd_pv_set": ("industrial_chiller.mold_temp.lcd_pv_set", False),
}
SHORT_CAT = {"barrel": "barrel", "hot_runner": "hr", "mold_temp_front": "mt_front",
             "mold_temp_rear": "mt_rear", "mold_temp_slide": "mt_slide"}
FIELD_LABEL = {"barrel": "成型条件-炮筒温度设定", "hot_runner": "成型条件-热流道温控箱温度",
               "mold_temp_front": "成型条件-模温机前模", "mold_temp_rear": "成型条件-模温机后模",
               "mold_temp_slide": "成型条件-模温机行位"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-id", default="batch_001")
    args = ap.parse_args()
    truth_dir = ROOT / "output/s054_download/truth" / args.batch_id
    img_dir = ROOT / "output/s054_download" / args.batch_id
    checkpoint = json.loads(
        (ROOT / f"output/s054_download/checkpoint_{args.batch_id}.json").read_text())
    record_by_file = {e["saved_name"]: e for e in checkpoint["entries"]
                      if e.get("status") == "kept"}

    n = 0
    for vision_path in sorted(truth_dir.glob("*.vision.json")):
        v = json.loads(vision_path.read_text(encoding="utf-8"))
        layout = v["layout"]
        if layout == "hangrui_lcd":
            layout = f"hangrui_lcd_{'front' if v['base_field_category'] == 'mold_temp_front' else 'rear'}"
        profile_id, is_positive = LAYOUT_PROFILE[layout]
        assert v["allow_auto_import"] == is_positive, f"{vision_path}: 正负例与归置不一致"

        src_img = img_dir / v["file"]
        sha8 = v["file"].rsplit("_", 1)[-1].split(".")[0][:8]
        case_id = f"{SHORT_CAT[v['base_field_category']]}_{v['loc']}_{sha8}"
        ext = src_img.suffix
        profile_dir = ROOT / "datasets/holdout" / profile_id
        profile_dir.mkdir(parents=True, exist_ok=True)
        dst_img = profile_dir / f"{case_id}{ext}"
        shutil.copy2(src_img, dst_img)

        rec = record_by_file.get(v["file"], {})
        truth = {
            "schema_version": "1.0.0",
            "case_id": case_id,
            "profile_id": profile_id,
            "controller_family": v["controller_family"],
            "page_type": v["page_type"],
            "hmi_variant": v["layout"],
            "allow_auto_import": v["allow_auto_import"],
            "image": {"file": dst_img.name},
            "fields": v["fields"],
            "provenance": {
                "source": {"note": f"飞书 Base 注塑机台监控汇总「{FIELD_LABEL[v['base_field_category']]}"
                                   f"」附件（record {rec.get('record_id')}，{v['brand']} {v['loc']}，"
                                   f"054 PLAN S01 批次 {args.batch_id}）"},
                "verified_by": "kimi-code 大模型逐图直接视觉核验（054 S01，contract 真值）",
                "verified_at": "2026-08-13",
                "tuning_involvement": "none",
                "placement_reason": "054 S01 新 holdout 验收批：hash 未出现在 calibration/regression/"
                                    "samples_temperature_base/samples_v4_holdout，未参与任何调参",
            },
            "notes": v["notes"],
        }
        (profile_dir / f"{case_id}.truth.yml").write_text(
            yaml.safe_dump(truth, allow_unicode=True, sort_keys=False), encoding="utf-8")
        n += 1
        print(f"  {case_id} -> {profile_id} ({'正例' if is_positive else '负例'})")
    print(f"[s054] holdout cases written: {n}")


if __name__ == "__main__":
    main()
