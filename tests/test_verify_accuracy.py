"""verify_accuracy 双模式聚焦测试（031 PLAN S01 / §4.5）。

- NUMERIC_FIELDS 硬编码清单已删除（模块不再导出该符号）；
- contract 模式：按字段目录 value_type 计分、容差取目录值、未登记字段硬失败、
  门禁全过且负例在场时 lifecycle_eligible=true、rejection N/A 时 false；
- legacy 模式：按真值值类型动态枚举数值键继续出报告，lifecycle_eligible=false。
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import verify_accuracy as va
import yaml

VERIFY = Path(__file__).resolve().parents[1] / "scripts" / "verify_accuracy.py"

CATALOG = {
    "contract_version": "9.9.9-test",
    "fields": {
        "stage_holding_pressure_bar": {
            "value_type": "list[float]", "unit": "bar", "tolerance": 0.5},
        "holding_note_text": {"value_type": "str", "unit": "-"},
    },
}


def write_case(truth_dir: Path, ext_dir: Path, case_id: str, *,
               truth_fields: dict, extracted_fields: dict | None,
               allow: bool = True, status: str = "ok") -> None:
    truth_dir.mkdir(parents=True, exist_ok=True)
    ext_dir.mkdir(parents=True, exist_ok=True)
    truth = {
        "schema_version": "1.0.0", "case_id": case_id,
        "profile_id": "p", "controller_family": "DEMAG",
        "page_type": "injection_metering", "hmi_variant": "v",
        "allow_auto_import": allow, "image": {"file": f"{case_id}.jpeg"},
        "fields": truth_fields, "provenance": {},
    }
    (truth_dir / f"{case_id}.truth.yml").write_text(
        yaml.dump(truth, allow_unicode=True, sort_keys=False), encoding="utf-8")
    if extracted_fields is not None:
        extracted = {"image": case_id, "status": status,
                     "controller_family": "DEMAG",
                     "page_type": "injection_metering",
                     "fields": extracted_fields, "warnings": []}
        (ext_dir / f"{case_id}.fields.json").write_text(
            json.dumps(extracted), encoding="utf-8")


class ModuleShapeTest(unittest.TestCase):
    def test_numeric_fields_constant_removed(self):
        self.assertFalse(hasattr(va, "NUMERIC_FIELDS"))

    def test_threshold_constants_kept_for_nightly_runner(self):
        self.assertEqual(va.GATE_NUMERIC_ACCURACY, 0.95)
        self.assertEqual(va.GATE_ERROR_AUTO_IMPORT_RATE, 0.0)
        self.assertEqual(va.TOLERANCE, 0.5)


class ModeTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.catalog = self.tmp / "field_catalog.json"
        self.catalog.write_text(json.dumps(CATALOG), encoding="utf-8")
        self.truth_dir = self.tmp / "truth"
        self.ext_dir = self.tmp / "extracted"
        self.out = self.tmp / "report.json"

    def run_verify(self) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(VERIFY), str(self.ext_dir),
             "--truth", str(self.truth_dir), "-o", str(self.out),
             "--catalog", str(self.catalog)],
            capture_output=True, text=True)


class ContractModeTest(ModeTestBase):
    def test_scores_by_catalog_value_type_and_eligible(self):
        write_case(self.truth_dir, self.ext_dir, "pos1",
                   truth_fields={"stage_holding_pressure_bar": [65.0, 50.0],
                                 "holding_note_text": "bar_spez"},
                   extracted_fields={"stage_holding_pressure_bar": [65.0, 50.0],
                                     "holding_note_text": "bar_spez"})
        write_case(self.truth_dir, self.ext_dir, "neg1", allow=False,
                   truth_fields={"stage_holding_pressure_bar": [1.0]},
                   extracted_fields={"stage_holding_pressure_bar": [1.0]},
                   status="reject")
        result = self.run_verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(report["mode"], "contract")
        self.assertEqual(report["contract_version"], "9.9.9-test")
        self.assertEqual(report["metrics"]["numeric_accuracy"], 1.0)
        self.assertEqual(report["metrics"]["rejection_accuracy"], 1.0)
        self.assertTrue(report["lifecycle_eligible"])

    def test_unregistered_field_hard_fails(self):
        write_case(self.truth_dir, self.ext_dir, "pos1",
                   truth_fields={"stage_holding_pressure_bar": [65.0],
                                 "unlisted_field": 1.0},
                   extracted_fields={"stage_holding_pressure_bar": [65.0]})
        result = self.run_verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("未登记字段", result.stdout + result.stderr)

    def test_rejection_na_not_lifecycle_eligible(self):
        write_case(self.truth_dir, self.ext_dir, "pos1",
                   truth_fields={"stage_holding_pressure_bar": [65.0]},
                   extracted_fields={"stage_holding_pressure_bar": [65.0]})
        result = self.run_verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertIsNone(report["metrics"]["rejection_accuracy"])
        self.assertEqual(report["gates"]["rejection_accuracy == 1"], "N/A")
        self.assertFalse(report["lifecycle_eligible"])

    def test_catalog_tolerance_applies(self):
        # 目录容差 0.5：偏差 0.4 计为匹配；文本字段等值比对
        write_case(self.truth_dir, self.ext_dir, "pos1",
                   truth_fields={"stage_holding_pressure_bar": [65.0],
                                 "holding_note_text": "bar"},
                   extracted_fields={"stage_holding_pressure_bar": [65.4],
                                     "holding_note_text": "bar"})
        result = self.run_verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(report["metrics"]["numeric_accuracy"], 1.0)


class LegacyModeTest(ModeTestBase):
    def test_dynamic_keys_and_not_lifecycle_eligible(self):
        self.truth_dir.mkdir()
        self.ext_dir.mkdir()
        (self.truth_dir / "img1.truth.json").write_text(json.dumps({
            "image": "img1.jpeg", "controller_family": "B_AND_R",
            "page_type": "temperature", "allow_auto_import": True,
            "fields": {"brand_new_never_listed_field": [200.0, 210.0],
                       "mode_text": "时间"},
        }), encoding="utf-8")
        (self.ext_dir / "img1.fields.json").write_text(json.dumps({
            "image": "img1", "status": "ok", "controller_family": "B_AND_R",
            "page_type": "temperature",
            "fields": {"brand_new_never_listed_field": [200.0, 210.0],
                       "mode_text": "时间"},
            "warnings": [],
        }), encoding="utf-8")
        result = self.run_verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(report["mode"], "legacy")
        # 历史键不在任何硬编码清单里也能动态计分（老真值不误算）
        self.assertEqual(report["metrics"]["numeric_accuracy"], 1.0)
        self.assertFalse(report["lifecycle_eligible"])
        self.assertIn("不得用于 profile 晋级", report["lifecycle_note"])


if __name__ == "__main__":
    unittest.main()
