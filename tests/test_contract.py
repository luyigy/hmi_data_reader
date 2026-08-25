import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from contract import attach_contract


def _injection_result(variant, fields=None):
    return {
        "image": "sample",
        "status": "ok",
        "warnings": [],
        "controller_family": "DEMAG",
        "page_type": "injection_metering",
        "fields": fields if fields is not None else {
            "stage_velocity_mms": [30.0, 25.0],
            "stage_pressure_bar": [80.0, 60.0],
        },
        "extraction_detail": {"page_variant": variant},
    }


class ContractProfileTest(unittest.TestCase):
    def test_injection_variant_profile_id(self):
        result = attach_contract(_injection_result("multi_stage_injection"))
        self.assertEqual(result["hmi_variant"], "multi_stage_injection")
        self.assertEqual(result["profile_id"],
                         "demag.injection_metering.multi_stage_injection")
        self.assertEqual(result["profile_status"], "verified")
        self.assertEqual(result["contract_version"], "2.11.0")

    def test_stage_velocity_web_target(self):
        result = attach_contract(_injection_result("multi_stage_injection"))
        meta = result["field_meta"]["stage_velocity_mms"]
        self.assertEqual(meta["web_target"], "injection_segment_speed")
        self.assertEqual(meta["unit"], "mm/s")
        self.assertEqual(meta["role"], "setpoint")

    def test_role_override_by_profile(self):
        back_pressure = attach_contract(_injection_result("multi_stage_back_pressure"))
        self.assertEqual(back_pressure["profile_id"],
                         "demag.injection_metering.multi_stage_back_pressure")
        self.assertEqual(back_pressure["profile_status"], "candidate")
        self.assertEqual(back_pressure["field_meta"]["stage_pressure_bar"]["role"],
                         "setpoint")
        # physical_semantics 目录中定义为 null 值时原样带上
        self.assertEqual(
            back_pressure["field_meta"]["stage_pressure_bar"]["physical_semantics"],
            {"pressure_basis": None})

        injection = attach_contract(_injection_result("multi_stage_injection"))
        self.assertEqual(injection["field_meta"]["stage_pressure_bar"]["role"],
                         "limit")

    def test_unregistered_profile_is_unknown(self):
        result = attach_contract(_injection_result("no_such_layout"))
        self.assertEqual(result["profile_id"],
                         "demag.injection_metering.no_such_layout")
        self.assertEqual(result["profile_status"], "unknown")

    def test_no_layout_variant_is_unknown(self):
        result = attach_contract({
            "image": "sample",
            "status": "reject",
            "warnings": ["NO_TEMPLATE(unknown,unknown)"],
            "controller_family": "unknown",
            "page_type": "unknown",
        })
        self.assertIsNone(result["profile_id"])
        self.assertEqual(result["profile_status"], "unknown")
        self.assertEqual(result["hmi_variant"], "unknown")
        self.assertEqual(result["field_meta"], {})
        # 无 layout_variant 时置信度封顶 0.69（低于 candidate 门槛）
        self.assertEqual(result["profile_confidence"], 0.69)

    def test_temperature_variant_from_template(self):
        result = attach_contract({
            "image": "sample",
            "status": "ok",
            "warnings": [],
            "controller_family": "DEMAG",
            "page_type": "temperature",
            "fields": {},
            "extraction_detail": {},
        })
        self.assertEqual(result["hmi_variant"], "screen_order_5")
        self.assertEqual(result["profile_id"], "demag.temperature.screen_order_5")
        self.assertEqual(result["profile_status"], "verified")

    def test_keba_dynamic_zone_labels_follow_recognized_count(self):
        for family in ("KEBA", "ZIZES"):
            for count in (5, 6):
                result = attach_contract({
                    "controller_family": family,
                    "page_type": "temperature",
                    "fields": {"barrel_temperature_set_c": [220.0] * count},
                })
                self.assertEqual(
                    result["field_meta"]["barrel_temperature_set_c"]["entity"]["columns"],
                    [f"温区{i}" for i in range(1, count + 1)],
                )

    def test_tact_zone_labels_follow_recognized_count(self):
        for count in (4, 5, 6):
            result = attach_contract({
                "controller_family": "TACT",
                "page_type": "temperature",
                "fields": {
                    "barrel_temperature_set_c": [290.0] * count,
                    "barrel_temperature_current_c": [290.1] * count,
                },
            })
            expected = ["喷嘴1", *[f"区{i}" for i in range(1, count)]]
            self.assertEqual(result["profile_id"], "tact.temperature.fixed")
            self.assertEqual(
                result["field_meta"]["barrel_temperature_set_c"]["entity"]["columns"],
                expected,
            )
            self.assertEqual(
                result["field_meta"]["barrel_temperature_current_c"]["entity"]["columns"],
                expected,
            )

    def test_fields_not_in_catalog_excluded(self):
        result = attach_contract(_injection_result(
            "multi_stage_injection",
            fields={"stage_velocity_mms": [1.0], "not_in_catalog_xyz": 1}))
        self.assertIn("stage_velocity_mms", result["field_meta"])
        self.assertNotIn("not_in_catalog_xyz", result["field_meta"])

    def test_tact_and_b_and_r_injection_fields_have_presentation_metadata(self):
        expected = {
            "fill_velocity_mms": ("各段充填速度", "mm/s"), "fill_stages": ("充填段数", "段"),
            "switch_position_sv1_mm": ("第 1 段充填切换位置", "mm"), "switch_position_sv2_mm": ("第 2 段充填切换位置", "mm"),
            "metering_position_sm_mm": ("计量位置", "mm"), "metering_rpm": ("计量转速", "rpm"),
            "back_pressure_mpa": ("熔胶背压", "MPa"), "holding_pressure_mpa": ("各段保压压力", "MPa"),
            "holding_stages": ("保压段数", "段"), "holding_limit_speed_mms": ("保压限制速度", "mm/s"),
            "vp_switch_position_mm": ("V/P 切换位置", "mm"), "pressure_limit_mpa": ("射胶压力上限", "MPa"),
            "injection_time_s": ("射出时间", "s"), "decompress_velocity_mms": ("减压速度", "mm/s"),
            "sd_position_mm": ("减压位置", "mm"), "injection_velocity_pct": ("各段射胶速度", "%"),
            "injection_pressure_bar": ("各段射胶压力", "bar"), "injection_position_mm": ("各段射胶位置", "mm"),
            "injection_stages": ("射胶段数", "段"), "holding_velocity_pct": ("各段保压速度", "%"),
            "holding_switch_mode": ("保压切换方式", "-"), "vp_switch_time_s": ("V/P 切换时间", "s"),
        }
        result = attach_contract(_injection_result(
            "unknown", fields={name: None for name in expected}))
        self.assertEqual(set(result["field_meta"]), set(expected))
        for name, (label, unit) in expected.items():
            with self.subTest(name=name):
                meta = result["field_meta"][name]
                self.assertEqual((meta["label_zh"], meta["unit"]), (label, unit))
                self.assertIsNone(meta["web_target"])


class ContractConfidenceTest(unittest.TestCase):
    def test_default_confidence_without_classification(self):
        result = attach_contract(_injection_result("multi_stage_injection"))
        self.assertEqual(result["profile_confidence"], 0.7)

    def test_min_of_classification_confidences(self):
        result = attach_contract(
            _injection_result("multi_stage_injection"),
            {"ui_family_confidence": 0.95, "page_confidence": 0.8})
        self.assertEqual(result["profile_confidence"], 0.8)

    def test_int_confidence_and_out_of_range_ignored(self):
        result = attach_contract(
            _injection_result("multi_stage_injection"),
            {"ui_family_confidence": 1, "page_confidence": 1.5})
        self.assertEqual(result["profile_confidence"], 1.0)
        result = attach_contract(
            _injection_result("multi_stage_injection"),
            {"ui_family_confidence": "high", "page_confidence": None})
        self.assertEqual(result["profile_confidence"], 0.7)

    def test_no_layout_caps_confidence(self):
        result = attach_contract(
            {"controller_family": "DEMAG", "page_type": "unknown",
             "fields": {}, "extraction_detail": {}},
            {"ui_family_confidence": 0.99, "page_confidence": 0.99})
        self.assertEqual(result["profile_confidence"], 0.69)


class ContractIdempotentTest(unittest.TestCase):
    def test_hmi_variant_not_v1_and_idempotent(self):
        result = _injection_result("multi_stage_holding")
        attach_contract(result)
        first = dict(result)
        self.assertNotEqual(result["hmi_variant"], "v1")
        # service 内带分类置信度第二次调用：仅 confidence 变化，其余键稳定
        attach_contract(result, {"ui_family_confidence": 0.92,
                                 "page_confidence": 0.88})
        self.assertEqual(result["profile_confidence"], 0.88)
        for key in ("hmi_variant", "profile_id", "profile_status",
                    "contract_version", "field_meta"):
            self.assertEqual(result[key], first[key])


class PressureBasisOverrideTest(unittest.TestCase):
    """extraction_detail.pressure_unit_text 对 physical_semantics.pressure_basis
    的运行时覆盖：bar_spez=塑料压力；bar/无标签保持目录原值（null 不猜）。"""

    def _holding_result(self, unit_text_marker):
        result = _injection_result("multi_stage_holding", fields={
            "stage_holding_pressure_bar": [65.0, 60.0],
            "stage_holding_time_s": [2.0, 1.0],
            "stage_holding_velocity_mms": [12.0],
        })
        if unit_text_marker is not None:
            result["extraction_detail"]["pressure_unit_text"] = unit_text_marker
        return result

    def test_holding_segment_web_targets(self):
        result = attach_contract(self._holding_result(None))
        meta = result["field_meta"]
        self.assertEqual(meta["stage_holding_pressure_bar"]["web_target"],
                         "holding_segment_pressure")
        self.assertEqual(meta["stage_holding_time_s"]["web_target"],
                         "holding_segment_time")
        self.assertIsNone(meta["stage_holding_velocity_mms"]["web_target"])

    def test_bar_spez_overrides_to_plastic_pressure(self):
        result = attach_contract(self._holding_result("bar_spez"))
        meta = result["field_meta"]
        self.assertEqual(
            meta["stage_holding_pressure_bar"]["physical_semantics"],
            {"pressure_basis": "plastic_pressure"})
        # 无 pressure_basis 维度的字段不受影响
        self.assertEqual(
            meta["stage_holding_time_s"]["physical_semantics"],
            {"time_definition": "segment_duration"})

    def test_bar_keeps_catalog_value(self):
        result = attach_contract(self._holding_result("bar"))
        self.assertEqual(
            result["field_meta"]["stage_holding_pressure_bar"]["physical_semantics"],
            {"pressure_basis": None})

    def test_no_unit_text_keeps_catalog_value(self):
        result = attach_contract(self._holding_result(None))
        self.assertEqual(
            result["field_meta"]["stage_holding_pressure_bar"]["physical_semantics"],
            {"pressure_basis": None})

    def test_catalog_cache_not_polluted(self):
        attach_contract(self._holding_result("bar_spez"))
        result = attach_contract(self._holding_result(None))
        self.assertEqual(
            result["field_meta"]["stage_holding_pressure_bar"]["physical_semantics"],
            {"pressure_basis": None})


if __name__ == "__main__":
    unittest.main()
