import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from extract_families.demag_injection import _extract_curve


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
        self.assertEqual(fields["stage_pressure_bar"], [0, 25, 75])
        self.assertEqual(fields["stage_velocity_mms"], [0, 22.5, 45])
        self.assertEqual(warnings, [])

        warnings = []
        fields = _extract_curve([t for t in complete if t["text"] != "22.5"], template, warnings)
        self.assertEqual(fields["stage_pressure_bar"], [])
        self.assertEqual(fields["stage_velocity_mms"], [])
        self.assertEqual(warnings, ["STAGE_REJECT(unverified_grid)"])


if __name__ == "__main__":
    unittest.main()
