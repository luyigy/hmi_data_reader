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
            {"text": "压力[bar]", "x": 0.22, "y": 0.68},
            {"text": "速度[mm/s]", "x": 0.22, "y": 0.72},
            {"text": "位置[mm]", "x": 0.22, "y": 0.75},
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
            {"text": "压力[bar]", "x": 0.22, "y": 0.68},
            {"text": "速度[mm/s]", "x": 0.22, "y": 0.72},
            {"text": "位置[mm]", "x": 0.22, "y": 0.75},
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
            {"text": "压力[bar]", "x": 0.22, "y": 0.68},
            {"text": "速度[mm/s]", "x": 0.22, "y": 0.72},
            {"text": "位置[mm]", "x": 0.22, "y": 0.75},
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
        # 030_FIX：速度行按分段输出；单个有效值时回退单值
        self.assertEqual(fields["stage_holding_velocity_mms"], [12])
        self.assertEqual(fields["holding_velocity_mms"], 12.0)
        # 注射/兼容误标键一律不输出
        for removed in ("pressure_limit_bar", "first_velocity_mms",
                        "first_position_mm", "stage_pressure_bar",
                        "stage_velocity_mms", "stage_position_mm",
                        "holding_pressure_bar", "switch_position_mm",
                        "injection_pressure_limit_bar"):
            self.assertNotIn(removed, fields)
        # 033_FIX 修复2：无图像观测时保持旧启发式并落 review（不猜）
        self.assertEqual(warnings, [
            "STAGE_ENABLED_UNVERIFIED(stage_holding_pressure_bar)",
            "STAGE_ENABLED_UNVERIFIED(stage_holding_velocity_mms)",
        ])

    def test_holding_per_stage_velocity(self):
        # 030_FIX（领域确认）：DEMAG 保压页速度行为分段字段 15/10/5（物理段序）
        toks = [t for t in self.HOLDING_TOKENS if t["text"] != "12.0"] + [
            {"text": "5.0", "x": 0.70, "y": 0.663},
            {"text": "10.0", "x": 0.79, "y": 0.663},
            {"text": "15.0", "x": 0.88, "y": 0.663},
        ]
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertEqual(fields["stage_holding_velocity_mms"], [15, 10, 5])
        self.assertNotIn("holding_velocity_mms", fields)

    def test_holding_missing_rows_warns_not_guesses(self):
        toks = [t for t in self.HOLDING_TOKENS
                if t["text"] not in ("0.000", "1.000", "2.000", "12.0")]
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertEqual(fields["_page_variant"], "multi_stage_holding")
        self.assertEqual(fields["stage_holding_pressure_bar"], [65, 60, 55])
        self.assertEqual(fields["stage_holding_time_s"], [])
        self.assertEqual(fields["stage_holding_velocity_mms"], [])
        self.assertNotIn("holding_velocity_mms", fields)
        self.assertIn("CELL_MISSING(stage_holding_time_s)", warnings)
        self.assertIn("CELL_MISSING(stage_holding_velocity_mms)", warnings)

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


class DemagPressureUnitTextTest(unittest.TestCase):
    """压力侧别观测：注射/保压变体从压力行标签原文提取单位字符串（背压变体不动）。"""

    TEMPLATE = DemagHoldingPageTest.TEMPLATE

    def _holding_detail(self, label_text):
        toks = [dict(t) for t in DemagHoldingPageTest.HOLDING_TOKENS]
        for t in toks:
            if t["text"] == "压力[bar]":
                t["text"] = label_text
        res = extract_injection_demag(toks, {"curve_page": self.TEMPLATE})
        assert res["detail"]["page_variant"] == "multi_stage_holding"
        return res["detail"]

    def test_bar_spez_label(self):
        self.assertEqual(self._holding_detail("压力[bar_spez]")["pressure_unit_text"],
                         "bar_spez")

    def test_bar_label(self):
        self.assertEqual(self._holding_detail("压力[bar]")["pressure_unit_text"],
                         "bar")

    def test_label_without_unit(self):
        self.assertIsNone(self._holding_detail("压力")["pressure_unit_text"])

    def test_back_pressure_variant_not_observed(self):
        toks = [
            {"text": "多级背压", "x": 0.5, "y": 0.03},
            {"text": "背压[bar]", "x": 0.18, "y": 0.628},
            {"text": "10.0", "x": 0.50, "y": 0.628},
            {"text": "20.0", "x": 0.60, "y": 0.628},
            {"text": "螺杆转速", "x": 0.18, "y": 0.668},
            {"text": "30.0", "x": 0.50, "y": 0.668},
            {"text": "40.0", "x": 0.60, "y": 0.668},
        ]
        res = extract_injection_demag(toks, {"curve_page": self.TEMPLATE})
        self.assertEqual(res["detail"]["page_variant"], "multi_stage_back_pressure")
        self.assertNotIn("pressure_unit_text", res["detail"])


class DemagRowAnchorDegradeTest(unittest.TestCase):
    """033_FIX 修复1：关键行锚词缺失时诚实降级（禁止 hint 兜底猜行）。"""

    TEMPLATE = DemagHoldingPageTest.TEMPLATE

    def test_missing_anchor_voids_stage_outputs(self):
        # cac666e7 型：左裁切导致行标签只剩半截，锚词全部不中；
        # hint 兜底会把压力/速度行互换且 status=ok——必须置空降级
        toks = [t for t in DemagHoldingPageTest.HOLDING_TOKENS
                if t["text"] != "速度[mm/s]"]
        warnings = []
        fields = _extract_curve(list(toks), self.TEMPLATE, warnings)
        self.assertEqual(fields["_page_variant"], "multi_stage_holding")
        self.assertIn("ROW_ANCHOR_MISSING(velocity)", warnings)
        self.assertEqual(fields["stage_holding_pressure_bar"], [])
        self.assertEqual(fields["stage_holding_time_s"], [])
        self.assertEqual(fields["stage_holding_velocity_mms"], [])
        self.assertNotIn("holding_velocity_mms", fields)

    def test_missing_anchor_voids_injection_left_column(self):
        # rank03 型：注射页三行锚词全部缺失，左列标量同样不可信
        toks = [
            {"text": "多级注射", "x": 0.5, "y": 0.03},
            {"text": "0", "x": 0.75, "y": 0.69},
            {"text": "25", "x": 0.80, "y": 0.69},
            {"text": "0", "x": 0.77, "y": 0.73},
            {"text": "22.5", "x": 0.82, "y": 0.73},
        ]
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertEqual(fields["_page_variant"], "multi_stage_injection")
        for key in ("pressure", "velocity", "position"):
            self.assertIn(f"ROW_ANCHOR_MISSING({key})", warnings)
        self.assertEqual(fields["stage_velocity_mms"], [])
        self.assertEqual(fields["stage_position_mm"], [])
        self.assertIsNone(fields["holding_pressure_bar"])
        self.assertIsNone(fields["injection_pressure_limit_bar"])

    def test_back_pressure_variant_unchanged_by_anchor_guard(self):
        # 背压变体不动：无锚词告警、无置空
        toks = [
            {"text": "多级背压", "x": 0.5, "y": 0.03},
            {"text": "背压[bar]", "x": 0.18, "y": 0.628},
            {"text": "10.0", "x": 0.50, "y": 0.628},
            {"text": "20.0", "x": 0.60, "y": 0.628},
            {"text": "螺杆转速", "x": 0.18, "y": 0.668},
            {"text": "30.0", "x": 0.50, "y": 0.668},
            {"text": "40.0", "x": 0.60, "y": 0.668},
        ]
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertEqual(fields["_page_variant"], "multi_stage_back_pressure")
        self.assertFalse(any(w.startswith("ROW_ANCHOR_MISSING") for w in warnings))


class DemagRowMisalignGuardTest(unittest.TestCase):
    """033_FIX 修复1b 错行护栏：锚词命中但偏移估计失败时按捕获数失衡降级。"""

    TEMPLATE = DemagHoldingPageTest.TEMPLATE

    def test_imbalanced_capture_voids_stage_outputs(self):
        # 2e22f85a 实测几何：数值行整体位于标签下方约 0.017-0.022（029 的
        # 偏移候选只向标签上方找），偏移估计落到 -0.02 → 压力行捕到速度行
        # 单值 5.0、时间行捕到压力行 4 值
        toks = [
            {"text": "实际切换", "x": 0.04, "y": 0.04},
            {"text": "速度[mm/s]", "x": 0.196, "y": 0.699},
            {"text": "5.0", "x": 0.830, "y": 0.716},
            {"text": "压力[bar]", "x": 0.192, "y": 0.736},
            {"text": "35.0", "x": 0.640, "y": 0.752},
            {"text": "45.0", "x": 0.702, "y": 0.753},
            {"text": "55.0", "x": 0.761, "y": 0.755},
            {"text": "55.0", "x": 0.824, "y": 0.756},
            {"text": "时间]", "x": 0.189, "y": 0.771},
            {"text": "1.000", "x": 0.637, "y": 0.792},
            {"text": "1.000", "x": 0.696, "y": 0.793},
            {"text": "2.000", "x": 0.755, "y": 0.795},
        ]
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertEqual(fields["_page_variant"], "multi_stage_holding")
        self.assertIn("STAGE_ROW_MISALIGN(pressure=1,time=4)", warnings)
        self.assertEqual(fields["stage_holding_pressure_bar"], [])
        self.assertEqual(fields["stage_holding_time_s"], [])
        self.assertEqual(fields["stage_holding_velocity_mms"], [])

    def test_balanced_capture_not_flagged(self):
        # 速度行合法全局单值（f29c52c4 型：压力 4 格、速度 1 格、时间 3 格）
        # 不参与失衡比较，不得误伤
        toks = [
            {"text": "实际切换", "x": 0.04, "y": 0.04},
            {"text": "速度[mms]", "x": 0.205, "y": 0.662},
            {"text": "5.0", "x": 0.889, "y": 0.657},
            {"text": "压力[bar]", "x": 0.198, "y": 0.704},
            {"text": "35.0", "x": 0.693, "y": 0.702},
            {"text": "45.0", "x": 0.758, "y": 0.702},
            {"text": "55.0", "x": 0.821, "y": 0.702},
            {"text": "55.0", "x": 0.885, "y": 0.701},
            {"text": "时间]", "x": 0.192, "y": 0.746},
            {"text": "1.000", "x": 0.690, "y": 0.746},
            {"text": "1.000", "x": 0.753, "y": 0.747},
            {"text": "2.000", "x": 0.816, "y": 0.746},
        ]
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertFalse(any(w.startswith("STAGE_ROW_MISALIGN") for w in warnings))
        self.assertEqual(fields["stage_holding_pressure_bar"], [55.0, 55.0, 45.0, 35.0])


class DemagMergeDedupeTest(unittest.TestCase):
    """033_FIX 修复3：同格（x<0.018）异值冲突时主 OCR 值优先。"""

    TEMPLATE = DemagHoldingPageTest.TEMPLATE

    def _injection_toks(self, extra):
        return [
            {"text": "多级注射", "x": 0.5, "y": 0.03},
            {"text": "压力[bar]", "x": 0.18, "y": 0.68},
            {"text": "65.0", "x": 0.35, "y": 0.68},
            {"text": "速度[mm/s]", "x": 0.18, "y": 0.72},
            {"text": "12.0", "x": 0.35, "y": 0.72},
            {"text": "位置[mm]", "x": 0.18, "y": 0.75},
            {"text": "17.50", "x": 0.35, "y": 0.75},
            {"text": "100.0", "x": 0.85, "y": 0.65},
        ] + extra

    def test_variant_token_dropped_on_conflict(self):
        # rank02 实测：段网格旁车 '004500' 与主 OCR '45.00' 同格异值
        toks = self._injection_toks([
            {"text": "25.0", "x": 0.80, "y": 0.69},
            {"text": "75.0", "x": 0.85, "y": 0.69},
            {"text": "22.50", "x": 0.80, "y": 0.73},
            {"text": "45.00", "x": 0.85, "y": 0.73},
            {"text": "004500", "x": 0.862, "y": 0.73, "src": "ocr_variant"},
        ])
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertEqual(fields["stage_velocity_mms"], [75, 25])
        self.assertEqual(fields["stage_position_mm"], [45, 22.5])
        self.assertEqual(warnings, [])

    def test_slot_token_dropped_on_conflict(self):
        toks = self._injection_toks([
            {"text": "25.0", "x": 0.80, "y": 0.69},
            {"text": "75.0", "x": 0.85, "y": 0.69},
            {"text": "22.50", "x": 0.80, "y": 0.73},
            {"text": "004500", "x": 0.85, "y": 0.73, "slot": True},
            {"text": "45.00", "x": 0.862, "y": 0.73},
        ])
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertEqual(fields["stage_position_mm"], [45, 22.5])

    def test_no_conflict_behavior_unchanged(self):
        # 无冲突场景：同格同值去重、远距异值都保留——与原行为一致
        toks = self._injection_toks([
            {"text": "25.0", "x": 0.80, "y": 0.69},
            {"text": "75.0", "x": 0.85, "y": 0.69},
            {"text": "75.0", "x": 0.855, "y": 0.69, "src": "ocr_variant"},
            {"text": "22.50", "x": 0.80, "y": 0.73},
            {"text": "45.00", "x": 0.85, "y": 0.73},
        ])
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE, warnings)
        self.assertEqual(fields["stage_velocity_mms"], [75, 25])
        self.assertEqual(fields["stage_position_mm"], [45, 22.5])


if __name__ == "__main__":
    unittest.main()