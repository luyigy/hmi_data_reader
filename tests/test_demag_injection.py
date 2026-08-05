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
        }
        labels = [
            {"text": "pressure", "x": 0.22, "y": 0.68},
            {"text": "velocity", "x": 0.22, "y": 0.72},
            {"text": "position", "x": 0.22, "y": 0.75},
            {"text": "65.0", "x": 0.35, "y": 0.68},
            {"text": "12.0", "x": 0.35, "y": 0.72},
            {"text": "17.50", "x": 0.35, "y": 0.75},
        ]
        complete = labels + [
            {"text": str(value), "x": x, "y": y}
            for y, values in ((0.69, (0, 25, 75)), (0.73, (0, 22.5, 45)))
            for x, value in zip((0.75, 0.80, 0.85), values)
        ] + [{"text": "45.00", "x": 0.86, "y": 0.73}]

        warnings = []
        fields = _extract_curve(complete, template, warnings)
        # 屏幕自右向左为第 1 段起，输出统一反转为物理段序（025_FIX）
        self.assertEqual(fields["stage_pressure_bar"], [75, 25, 0])
        self.assertEqual(fields["stage_velocity_mms"], [45, 22.5, 0])
        self.assertEqual(warnings, [])

        warnings = []
        fields = _extract_curve([t for t in complete if t["x"] < 0.5], template, warnings)
        self.assertEqual(fields["stage_pressure_bar"], [])
        self.assertEqual(fields["stage_velocity_mms"], [])
        self.assertEqual(warnings, ["STAGE_REJECT(unverified_grid)"])

    def test_relaxed_grid_alignment(self):
        template = {
            "row_anchors": {
                "pressure": ["pressure"],
                "velocity": ["velocity"],
                "position": ["position"],
            },
            "row_y_hint": {"pressure": 0.68, "velocity": 0.72, "position": 0.75},
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
        ]
        warnings = []
        fields = _extract_curve(complete, template, warnings)
        # 屏幕自右向左为第 1 段起，输出统一反转为物理段序（025_FIX）
        self.assertEqual(fields["stage_pressure_bar"], [25, 0])
        self.assertEqual(fields["stage_velocity_mms"], [22.5, 0])
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
        self.assertEqual(res["fields"]["pressure_limit_bar"], 65.0)


if __name__ == "__main__":
    unittest.main()

