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
        self.assertEqual(result["contract_version"], "2.0.0")

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

    def test_fields_not_in_catalog_excluded(self):
        result = attach_contract(_injection_result(
            "multi_stage_injection",
            fields={"stage_velocity_mms": [1.0], "not_in_catalog_xyz": 1}))
        self.assertIn("stage_velocity_mms", result["field_meta"])
        self.assertNotIn("not_in_catalog_xyz", result["field_meta"])


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


if __name__ == "__main__":
    unittest.main()
