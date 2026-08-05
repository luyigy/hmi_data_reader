import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from extract_families.demag_injection import _extract_curve, extract_injection_demag


class DemagStageGridTest(unittest.TestCase):
    def test_only_releases_complete_aligned_rows(self):
        template = {
            "row_anchors": {
                "pressure": ["pressure"],
                "velocity": ["velocity"],
                "position": ["position"],
            },
            "row_y_hint": {"pressure": 0.68, "velocity": 0.72, "position": 0.75},
            "global_pressure": {"x_min": 0.6, "dy_above": [0.01, 0.06]},
        }
        labels = [
            {"text": "pressure", "x": 0.22, "y": 0.68},
            {"text": "velocity", "x": 0.22, "y": 0.72},
            {"text": "position", "x": 0.22, "y": 0.75},
            {"text": "65.0", "x": 0.35, "y": 0.68},
            {"text": "12.0", "x": 0.35, "y": 0.72},
            {"text": "17.50", "x": 0.35, "y": 0.75},
        ]
        # 026_FIX 语义：段表上 row（y=0.69）=各段射胶速度、下 row（y=0.73）=各段起点位置；
        # 左列=保压压力/保压速度/V-P 切换位置；右上=全局射胶压力上限
        complete = labels + [
            {"text": str(value), "x": x, "y": y}
            for y, values in ((0.69, (0, 25, 75)), (0.73, (0, 22.5, 45)))
            for x, value in zip((0.75, 0.80, 0.85), values)
        ] + [{"text": "45.00", "x": 0.86, "y": 0.73},
             {"text": "100.0", "x": 0.85, "y": 0.65}]

        warnings = []
        fields = _extract_curve(complete, template, warnings)
        # 屏幕自右向左为第 1 段起，输出统一反转为物理段序（025_FIX）
        self.assertEqual(fields["stage_velocity_mms"], [75, 25, 0])
        self.assertEqual(fields["stage_position_mm"], [45, 22.5, 0])
        self.assertEqual(fields["holding_pressure_bar"], 65.0)
        self.assertEqual(fields["holding_velocity_mms"], 12.0)
        self.assertEqual(fields["switch_position_mm"], 17.5)
        self.assertEqual(fields["injection_pressure_limit_bar"], 100.0)
        # 误标字段不再输出
        for removed in ("pressure_limit_bar", "first_velocity_mms",
                        "first_position_mm", "stage_pressure_bar"):
            self.assertNotIn(removed, fields)
        self.assertEqual(warnings, [])

        warnings = []
        fields = _extract_curve([t for t in complete if t["x"] < 0.5], template, warnings)
        self.assertEqual(fields["stage_velocity_mms"], [])
        self.assertEqual(fields["stage_position_mm"], [])
        self.assertEqual(warnings, ["CELL_MISSING(injection_pressure_limit_bar)",
                                    "STAGE_REJECT(unverified_grid)"])

    def test_relaxed_grid_alignment(self):
        template = {
            "row_anchors": {
                "pressure": ["pressure"],
                "velocity": ["velocity"],
                "position": ["position"],
            },
            "row_y_hint": {"pressure": 0.68, "velocity": 0.72, "position": 0.75},
            "global_pressure": {"x_min": 0.6, "dy_above": [0.01, 0.06]},
        }
        labels = [
            {"text": "pressure", "x": 0.22, "y": 0.68},
            {"text": "velocity", "x": 0.22, "y": 0.72},
            {"text": "position", "x": 0.22, "y": 0.75},
            {"text": "65.0", "x": 0.35, "y": 0.68},
            {"text": "12.0", "x": 0.35, "y": 0.72},
            {"text": "17.50", "x": 0.35, "y": 0.75},
        ]
        # X-coords for pressure vs velocity have a 0.03 shift (e.g. 0.75 vs 0.78), within 0.035 tolerance
        complete = labels + [
            {"text": "0", "x": 0.75, "y": 0.69},
            {"text": "25", "x": 0.80, "y": 0.69},
            {"text": "0", "x": 0.77, "y": 0.73},
            {"text": "22.5", "x": 0.82, "y": 0.73},
            {"text": "100.0", "x": 0.85, "y": 0.65},
        ]
        warnings = []
        fields = _extract_curve(complete, template, warnings)
        # 屏幕自右向左为第 1 段起，输出统一反转为物理段序（025_FIX）
        self.assertEqual(fields["stage_velocity_mms"], [25, 0])
        self.assertEqual(fields["stage_position_mm"], [22.5, 0])
        self.assertEqual(warnings, [])

    def test_optim_fallback_to_curve(self):
        template = {
            "curve_page": {
                "row_anchors": {
                    "pressure": ["pressure"],
                    "velocity": ["velocity"],
                    "position": ["position"],
                },
                "row_y_hint": {"pressure": 0.68, "velocity": 0.72, "position": 0.75},
            },
            "optimization_page": {
                "cell_tolerance": {"dx": 0.05, "dy": 0.02},
                "fields": {
                    "f1": {"row_y": 0.1, "col_x": 0.1, "range": (0, 100)},
                    "f2": {"row_y": 0.2, "col_x": 0.2, "range": (0, 100)},
                },
            },
        }
        # Tokens that don't match optimization_page cells, but contain curve_page data
        tokens = [
            {"text": "pressure", "x": 0.22, "y": 0.68},
            {"text": "velocity", "x": 0.22, "y": 0.72},
            {"text": "position", "x": 0.22, "y": 0.75},
            {"text": "65.0", "x": 0.35, "y": 0.68},
            {"text": "12.0", "x": 0.35, "y": 0.72},
            {"text": "17.50", "x": 0.35, "y": 0.75},
        ]
        res = extract_injection_demag(tokens, template)
        self.assertEqual(res["detail"]["page_variant"], "multi_stage_injection")
        # 026_FIX：左列首值=保压压力（非 pressure_limit_bar）
        self.assertEqual(res["fields"]["holding_pressure_bar"], 65.0)
        self.assertNotIn("pressure_limit_bar", res["fields"])


class DemagHoldingPageTest(unittest.TestCase):
    """035 保压页独立 profile（真值 ground_truth/demag_holding，app 反馈 e3ebbba2）。"""

    TEMPLATE = {
        "row_anchors": {
            "pressure": ["pressure"],
            "velocity": ["velocity"],
            "position": ["position"],
        },
        "row_y_hint": {"pressure": 0.68, "velocity": 0.72, "position": 0.75},
        "global_pressure": {"x_min": 0.6, "dy_above": [0.01, 0.06]},
    }

    HOLDING_TOKENS = [
        # 左列实际值区（标题在裁切中缺席）
        {"text": "实际切换", "x": 0.04, "y": 0.04},
        {"text": "94.0bar", "x": 0.03, "y": 0.09},
        {"text": "保压", "x": 0.04, "y": 0.15},
        {"text": "64.8bar", "x": 0.04, "y": 0.20},
        {"text": "位置", "x": 0.05, "y": 0.26},
        {"text": "16.64mm", "x": 0.04, "y": 0.31},
        {"text": "余料量", "x": 0.05, "y": 0.36},
        # 段表：速度行（全局单值）、压力行、时间行（最左 0 值为未启用槽位）
        {"text": "速度[mm/s]", "x": 0.19, "y": 0.666},
        {"text": "12.0", "x": 0.88, "y": 0.663},
        {"text": "压力[bar]", "x": 0.18, "y": 0.720},
        {"text": "0.0", "x": 0.69, "y": 0.720},
        {"text": "55.0", "x": 0.75, "y": 0.721},
        {"text": "60.0", "x": 0.82, "y": 0.721},
        {"text": "65.0", "x": 0.88, "y": 0.721},
        {"text": "时间]", "x": 0.18, "y": 0.773},
        {"text": "0.000", "x": 0.68, "y": 0.779},
        {"text": "1.000", "x": 0.75, "y": 0.779},
        {"text": "2.000", "x": 0.81, "y": 0.779},
        {"text": "多级速度", "x": 0.90, "y": 0.955},
    ]

    def test_holding_variant_and_physical_stage_order(self):
        warnings = []
        fields = _extract_curve(list(self.HOLDING_TOKENS), self.TEMPLATE, warnings)
        self.assertEqual(fields["_page_variant"], "multi_stage_holding")
        # 屏幕自右向左为第 1 段起，输出物理段序；最左 0 值未启用槽位剔除
        self.assertEqual(fields["stage_holding_pressure_bar"], [65, 60, 55])
        self.assertEqual(fields["stage_holding_time_s"], [2, 1])
        self.assertEqual(fields["holding_velocity_mms"], 12.0)
        # 注射/兼容误标键一律不输出
        for removed in ("pressure_limit_bar", "first_velocity_mms",
                        "first_position_mm", "stage_pressure_bar",
                        "stage_velocity_mms", "stage_position_mm",
                        "holding_pressure_bar", "switch_position_mm",
                        "injection_pressure_limit_bar"):
            self.assertNotIn(removed, fields)
        self.assertEqual(warnings, [])

    def test_holding_missing_rows_warns_not_guesses(self):
        toks = [t for t in self.HOLDING_TOKENS
                if t["text"] not in ("0.000", "1.000", "2.000", "12.0")]
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertEqual(fields["_page_variant"], "multi_stage_holding")
        self.assertEqual(fields["stage_holding_pressure_bar"], [65, 60, 55])
        self.assertEqual(fields["stage_holding_time_s"], [])
        self.assertIsNone(fields["holding_velocity_mms"])
        self.assertIn("CELL_MISSING(stage_holding_time_s)", warnings)
        self.assertIn("CELL_MISSING(holding_velocity_mms)", warnings)

    def test_injection_page_not_flipped_by_holding_anchors(self):
        # 多级注射页："注射时间"在左列 y<0.5（不得命中"时间"行指纹），
        # 段表下行标签为"位置[mm]"，无"实际切换"
        toks = [
            {"text": "多级注射", "x": 0.5, "y": 0.03},
            {"text": "注射时间", "x": 0.18, "y": 0.24},
            {"text": "0.909s", "x": 0.35, "y": 0.27},
            {"text": "压力[bar]", "x": 0.18, "y": 0.68},
            {"text": "65.0", "x": 0.35, "y": 0.68},
            {"text": "速度[mm/s]", "x": 0.18, "y": 0.72},
            {"text": "12.0", "x": 0.35, "y": 0.72},
            {"text": "位置[mm]", "x": 0.18, "y": 0.75},
            {"text": "17.50", "x": 0.35, "y": 0.75},
            {"text": "25.0", "x": 0.80, "y": 0.69},
            {"text": "75.0", "x": 0.85, "y": 0.69},
            {"text": "22.50", "x": 0.80, "y": 0.73},
            {"text": "45.00", "x": 0.85, "y": 0.73},
            {"text": "100.0", "x": 0.85, "y": 0.65},
        ]
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertEqual(fields["_page_variant"], "multi_stage_injection")
        self.assertEqual(fields["stage_velocity_mms"], [75, 25])
        self.assertEqual(fields["stage_position_mm"], [45, 22.5])
        self.assertNotIn("stage_holding_pressure_bar", fields)


if __name__ == "__main__":
    unittest.main()
