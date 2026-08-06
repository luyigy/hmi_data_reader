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
    _extract_curve,
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
            {"text": "压力[bar]", "x": 0.22, "y": 0.68},
            {"text": "速度[mm/s]", "x": 0.22, "y": 0.72},
            {"text": "位置[mm]", "x": 0.22, "y": 0.75},
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


class StageEnabledFilterTest(unittest.TestCase):
    """033_FIX 修复2：保压变体数值剔除/反转以 enabled 观测为准。

    - 深色禁用槽任何值（含非零旧值 35）剔除；
    - 浅色启用槽的 0 保留（06b7efe8 真值 P=[39.7,52.9,0]）；
    - 时间行例外维持旧"前导 0 剔除"（f29c52c4 真值 T=[2,1,1] 保留深色槽
      1.000，与禁用剔除规则冲突，以真值为准）。
    """

    TEMPLATE = {
        "row_y_hint": {"pressure": 0.68, "velocity": 0.72, "position": 0.75},
    }

    def _img(self, dark_cells):
        # 白底 200；dark_cells 里的 (x, y) 格涂深（比值 0.4 < DARK_CELL_RATIO）
        img = np.full((400, 1000), 200, dtype=np.uint8)
        for x, y in dark_cells:
            img[int(y * 400) - 12:int(y * 400) + 12,
                int(x * 1000) - 35:int(x * 1000) + 35] = 80
        return img

    BASE_TOKENS = [
        {"text": "实际切换", "x": 0.04, "y": 0.04},
        {"text": "速度[mm/s]", "x": 0.19, "y": 0.666},
        {"text": "12.0", "x": 0.88, "y": 0.663},
        {"text": "压力[bar]", "x": 0.18, "y": 0.720},
        {"text": "时间]", "x": 0.18, "y": 0.773},
        {"text": "1.000", "x": 0.69, "y": 0.773},
        {"text": "1.000", "x": 0.75, "y": 0.773},
        {"text": "2.000", "x": 0.82, "y": 0.773},
    ]

    def test_dark_nonzero_stale_value_dropped(self):
        # f29c52c4 型：压力行深色槽残留旧值 35 剔除；时间行深色槽 1.000 保留
        toks = self.BASE_TOKENS + [
            {"text": "35.0", "x": 0.69, "y": 0.720},
            {"text": "45.0", "x": 0.75, "y": 0.720},
            {"text": "55.0", "x": 0.82, "y": 0.720},
            {"text": "55.0", "x": 0.88, "y": 0.720},
        ]
        img = self._img([(0.69, 0.720), (0.69, 0.773)])
        warnings = []
        fields = _extract_curve(list(toks), self.TEMPLATE, warnings, img=img)
        self.assertEqual(fields["stage_holding_pressure_bar"], [55.0, 55.0, 45.0])
        self.assertEqual(fields["stage_holding_time_s"], [2.0, 1.0, 1.0])
        self.assertEqual(fields["stage_holding_velocity_mms"], [12.0])
        self.assertEqual(fields["holding_velocity_mms"], 12.0)
        self.assertEqual(fields["_stage_enabled"]["stage_holding_pressure_bar"],
                         [True, True, True])
        self.assertEqual(warnings, [])

    def test_enabled_zero_kept_dark_zero_dropped(self):
        # 06b7efe8 型：压力行 [深色 0, 浅色 0, 52.9, 39.7] -> [39.7, 52.9, 0]
        toks = self.BASE_TOKENS + [
            {"text": "0.0", "x": 0.69, "y": 0.720},
            {"text": "0.0", "x": 0.75, "y": 0.720},
            {"text": "52.9", "x": 0.82, "y": 0.720},
            {"text": "39.7", "x": 0.88, "y": 0.720},
        ]
        img = self._img([(0.69, 0.720), (0.69, 0.773)])
        warnings = []
        fields = _extract_curve(list(toks), self.TEMPLATE, warnings, img=img)
        self.assertEqual(fields["stage_holding_pressure_bar"], [39.7, 52.9, 0.0])
        self.assertEqual(warnings, [])


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
# 段数组为 033_FIX 修复2 后产出——enabled 观测过滤：ab30f6f6 的浅色启用段 0
# 保留（与真值 [65,50,0] 一致，原"前导双 0 剔除"差距消除）；barspez_65f50de2
# 的浅色 0 格同样保留（真值记 [1000,800]——与 ab30f6f6 真值语义冲突，已上报
# 待王为复核，识别侧按 Layer 1 观测统一保留）
HOLDING_EXPECTED = {
    "holding_Z002_1785755259328": {
        "stage_holding_pressure_bar": ([65.0, 60.0, 55.0], [True, True, True]),
        "stage_holding_time_s": ([2.0, 1.0], [True, True]),
        "stage_holding_velocity_mms": ([12.0], [True]),
    },
    "holding_Z002_ab30f6f6": {
        # 真值注记：压力 65/50/0，第 3 段 0=未启用但保留真值；033_FIX 后
        # enabled 观测该格为浅色启用 -> 保留，与真值一致
        "stage_holding_pressure_bar": ([65.0, 50.0, 0.0], [True, True, True]),
        "stage_holding_time_s": ([2.0, 3.0], [True, True]),
        "stage_holding_velocity_mms": ([15.0, 10.0, 5.0], [True, True, True]),
    },
    "holding_Z002_barspez_65f50de2": {
        # 真值记 [1000,800]，但enabled 观测第 3 格为浅色（与 ab30f6f6 同构）
        # -> 保留 0。真值间冲突待王为复核（033_FIX 报告）
        "stage_holding_pressure_bar": ([1000.0, 800.0, 0.0], [True, True, True]),
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
