"""Layer 1 禁用段图像观测（stage_enabled）测试。

- 合成图钉住亮度判定语义（深色格=False，阈值 DARK_CELL_RATIO 标定见
  scripts/extract_families/demag_injection.py 注释）；
- rank01 校准夹具（output/inj_z002_calib/rectified/）跑 extract_one：
  物理序 [75,25,0] 的尾段 0 为深色禁用槽位，观测应为 [True, True, False]；
- 5 张保压真值图（ground_truth/demag_holding/，本地管线产物在
  output/holding_probe/rectified/）逐张断言与真值注记一致；
- 无图像时优雅降级（无 stage_enabled 输出），观测不进 fields。
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from extract_fields import extract_one
from extract_families.demag_injection import (
    DARK_CELL_RATIO,
    _stage_enabled,
    extract_injection_demag,
)

REPO = Path(__file__).resolve().parents[1]
CALIB_DIR = REPO / "output" / "inj_z002_calib" / "rectified"
HOLDING_DIR = REPO / "output" / "holding_probe" / "rectified"
TEMPLATES = REPO / "templates"

RANK01 = "inj_Z002_20250516_rank01_recuQJJFYYMldc"


class StageEnabledUnitTest(unittest.TestCase):
    def test_dark_cell_detected_on_synthetic_image(self):
        # 白底 200 + 深色格 80（比值 0.4 < DARK_CELL_RATIO）；深色块填满
        # 首格采样窗（窗宽=相邻格距 0.2*0.9=0.18 → 像素 x 10..190）
        img = np.full((400, 1000), 200, dtype=np.uint8)
        img[160:240, 10:190] = 80
        captures = {"row": [(0.1, 0.5), (0.3, 0.5), (0.5, 0.5)]}
        enabled = _stage_enabled(img, captures)
        self.assertEqual(enabled, {"row": [False, True, True]})

    def test_all_bright_cells_enabled(self):
        img = np.full((400, 1000), 190, dtype=np.uint8)
        captures = {"row": [(0.1, 0.5), (0.3, 0.5)]}
        enabled = _stage_enabled(img, captures)
        self.assertEqual(enabled, {"row": [True, True]})

    def test_threshold_ratio_between_calibrated_groups(self):
        # 标定区间断言：禁用格比值 <=0.65、启用格 >=0.86，阈值须落在两者之间
        self.assertGreater(DARK_CELL_RATIO, 0.65)
        self.assertLess(DARK_CELL_RATIO, 0.86)


class NoImageDegradeTest(unittest.TestCase):
    def test_no_image_no_stage_enabled(self):
        template = {
            "curve_page": {
                "row_y_hint": {"pressure": 0.68, "velocity": 0.72, "position": 0.75},
                "global_pressure": {"x_min": 0.6, "dy_above": [0.01, 0.06]},
            }
        }
        toks = [
            {"text": "多级注射", "x": 0.3, "y": 0.1},
            {"text": "pressure", "x": 0.22, "y": 0.68},
            {"text": "velocity", "x": 0.22, "y": 0.72},
            {"text": "position", "x": 0.22, "y": 0.75},
            {"text": "65.0", "x": 0.35, "y": 0.68},
            {"text": "12.0", "x": 0.35, "y": 0.72},
            {"text": "17.50", "x": 0.35, "y": 0.75},
        ] + [
            {"text": str(value), "x": x, "y": y}
            for y, values in ((0.69, (0, 25, 75)), (0.73, (0, 22.5, 45)))
            for x, value in zip((0.75, 0.80, 0.85), values)
        ] + [{"text": "100.0", "x": 0.85, "y": 0.65}]
        result = extract_injection_demag(toks, template)
        self.assertNotIn("stage_enabled", result["detail"])
        # 数值产出与无观测路径一致
        self.assertEqual(result["fields"]["stage_velocity_mms"], [75, 25, 0])
        self.assertNotIn("_stage_enabled", result["fields"])


@unittest.skipUnless((CALIB_DIR / f"{RANK01}.png").is_file(),
                     "inj_z002_calib 夹具不在本地")
class Rank01FixtureTest(unittest.TestCase):
    def test_stage_enabled_aligned_with_stage_arrays(self):
        result = extract_one(RANK01, CALIB_DIR, None, None, TEMPLATES)
        detail = result["extraction_detail"]
        fields = result["fields"]
        self.assertEqual(detail["page_variant"], "multi_stage_injection")
        self.assertEqual(fields["stage_velocity_mms"], [75.0, 25.0, 0.0])
        self.assertEqual(fields["stage_position_mm"], [45.0, 22.5, 0.0])
        enabled = detail["stage_enabled"]
        # rank01 真值 [75,25,0]：尾段 0 为深色禁用槽位
        self.assertEqual(enabled["stage_velocity_mms"], [True, True, False])
        self.assertEqual(enabled["stage_position_mm"], [True, True, False])
        # 逐位对齐护栏 + 观测不进 fields
        for key, flags in enabled.items():
            self.assertEqual(len(flags), len(fields[key]))
            self.assertNotIn("stage_enabled", fields)


# 5 张保压真值图的期望（与 ground_truth/demag_holding/*.truth.json 注记一致；
# 段数组为现行数值产出——含 ab30f6f6 前导双 0 剔除的已知差距——观测逐位对齐）
HOLDING_EXPECTED = {
    "holding_Z002_1785755259328": {
        "stage_holding_pressure_bar": ([65.0, 60.0, 55.0], [True, True, True]),
        "stage_holding_time_s": ([2.0, 1.0], [True, True]),
        "stage_holding_velocity_mms": ([12.0], [True]),
    },
    "holding_Z002_ab30f6f6": {
        # 真值注记：压力 65/50/0，第 3 段 0=未启用；前导深色槽位剔除规则
        # 把禁用段 0 也剔了（已知差距，数值语义不在本层修）
        "stage_holding_pressure_bar": ([65.0, 50.0], [True, True]),
        "stage_holding_time_s": ([2.0, 3.0], [True, True]),
        "stage_holding_velocity_mms": ([15.0, 10.0, 5.0], [True, True, True]),
    },
    "holding_Z002_barspez_65f50de2": {
        "stage_holding_pressure_bar": ([1000.0, 800.0], [True, True]),
        "stage_holding_time_s": ([2.0, 3.0], [True, True]),
        "stage_holding_velocity_mms": ([15.0, 10.0, 5.0], [True, True, True]),
    },
    "holding_Z002_e4d130e8": {
        "stage_holding_pressure_bar": ([83.0, 60.0, 60.0], [True, True, True]),
        "stage_holding_time_s": ([2.0, 3.0], [True, True]),
        "stage_holding_velocity_mms": ([15.0, 12.0, 12.0], [True, True, True]),
    },
    "holding_Z002_photo_1784721642626": {
        "stage_holding_pressure_bar": ([65.0, 60.0, 55.0], [True, True, True]),
        "stage_holding_time_s": ([2.0, 1.0], [True, True]),
        "stage_holding_velocity_mms": ([12.0], [True]),
    },
}


@unittest.skipUnless(HOLDING_DIR.is_dir()
                     and any(HOLDING_DIR.glob("*.rectify.json")),
                     "holding_probe 本地管线产物不在本地")
class HoldingTruthTest(unittest.TestCase):
    def test_stage_enabled_matches_truth_notes(self):
        for stem, expected in HOLDING_EXPECTED.items():
            with self.subTest(stem=stem):
                result = extract_one(stem, HOLDING_DIR, None, None, TEMPLATES)
                detail = result["extraction_detail"]
                fields = result["fields"]
                self.assertEqual(detail["page_variant"], "multi_stage_holding")
                enabled = detail.get("stage_enabled", {})
                for key, (values, flags) in expected.items():
                    self.assertEqual(fields[key], values, key)
                    self.assertEqual(enabled.get(key), flags, key)
                    self.assertEqual(len(enabled[key]), len(fields[key]), key)


if __name__ == "__main__":
    unittest.main()
