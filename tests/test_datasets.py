"""datasets 双层真值治理聚焦测试（031 PLAN S01）。

用临时目录合成最小数据集（独立小 catalog/registry），覆盖：
- build 生成 meta + release manifest，check 通过；
- 篡改 truth（hash 漂移）、篡改 meta、孤儿 meta、缺 meta 均硬失败；
- 分区内 case 重复、跨分区 case/图片重复硬失败；
- calibration/regression 引用 holdout case 硬失败；
- truth 缺必需键、字段未在目录登记、目录名与 profile_id 不符硬失败。
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import yaml

import datasets as ds

CATALOG = {
    "contract_version": "9.9.9-test",
    "fields": {
        "stage_holding_pressure_bar": {
            "value_type": "list[float]", "unit": "bar", "tolerance": 0.5,
            "label_zh": "各段保压压力", "page_label_zh": "射胶页面",
            "role": "setpoint", "entity": {"kind": "holding_segment",
                                           "identity": "array_order"},
            "web_target": "holding_segment_pressure",
        },
    },
}
REGISTRY = {"profiles": [{"profile_id": "demag.injection_metering.multi_stage_holding",
                          "status": "candidate"}]}
PROFILE = "demag.injection_metering.multi_stage_holding"


def make_case(root: Path, partition: str, case_id: str, *,
              image_bytes: bytes | None = None, truth_overrides: dict | None = None,
              profile: str = PROFILE) -> Path:
    case_dir = root / partition / profile
    case_dir.mkdir(parents=True, exist_ok=True)
    img = image_bytes if image_bytes is not None else f"img-{case_id}".encode()
    (case_dir / f"{case_id}.jpeg").write_bytes(img)
    truth = {
        "schema_version": "1.0.0",
        "case_id": case_id,
        "profile_id": profile,
        "controller_family": "DEMAG",
        "page_type": "injection_metering",
        "hmi_variant": "multi_stage_holding",
        "allow_auto_import": False,
        "image": {"file": f"{case_id}.jpeg"},
        "fields": {"stage_holding_pressure_bar": [65.0, 50.0]},
        "provenance": {"verified_by": "测试", "placement_reason": "合成夹具"},
    }
    if truth_overrides:
        truth.update(truth_overrides)
    path = case_dir / f"{case_id}.truth.yml"
    path.write_text(yaml.dump(truth, allow_unicode=True, sort_keys=False),
                    encoding="utf-8")
    return path


class FixtureMixin:
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.catalog_path = self.tmp / "field_catalog.json"
        self.catalog_path.write_text(json.dumps(CATALOG), encoding="utf-8")
        self.registry_path = self.tmp / "profiles.json"
        self.registry_path.write_text(json.dumps(REGISTRY), encoding="utf-8")
        self.catalog = ds.load_catalog(self.catalog_path)
        self.registry_ids = ds.load_registry_ids(self.registry_path)
        self.datasets = self.tmp / "datasets"

    def build(self):
        cases, errors = ds.validate(self.datasets, self.catalog,
                                    self.registry_ids, write=True)
        return cases, errors

    def check(self):
        cases, errors = ds.validate(self.datasets, self.catalog,
                                    self.registry_ids, write=False)
        if not errors:
            valid = [c for c in cases if c["truth"] is not None]
            manifest = ds.build_manifest(valid, self.catalog)
            errors.extend(ds.check_manifest(self.datasets / "release_manifest.json",
                                            manifest))
        return errors


class BuildAndTamperTest(FixtureMixin, unittest.TestCase):
    def test_build_then_check_and_manifest(self):
        make_case(self.datasets, "calibration", "case_a")
        make_case(self.datasets, "regression", "case_b")
        cases, errors = self.build()
        self.assertEqual(errors, [])
        valid = [c for c in cases if c["truth"] is not None]
        manifest = ds.build_manifest(valid, self.catalog)
        (self.datasets / "release_manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        self.assertEqual(manifest["totals"], {"calibration": 1, "holdout": 0,
                                              "regression": 1})
        meta = json.loads((self.datasets / "calibration" / PROFILE
                           / "case_a.meta.json").read_text(encoding="utf-8"))
        for key in ("case_id", "truth_hash", "image_sha256", "schema_version",
                    "contract_version", "profile_id", "profile_layout_version",
                    "structure", "field_meta", "provenance"):
            self.assertIn(key, meta)
        self.assertEqual(meta["contract_version"], "9.9.9-test")
        self.assertEqual(self.check(), [])

    def _build_one(self):
        make_case(self.datasets, "calibration", "case_a")
        self.build()
        (self.datasets / "release_manifest.json").write_text(
            json.dumps(ds.build_manifest(
                [c for c in ds.scan_cases(self.datasets) if c["truth"] is not None],
                self.catalog), ensure_ascii=False), encoding="utf-8")

    def test_truth_tamper_fails_check(self):
        truth_path = make_case(self.datasets, "calibration", "case_a")
        self._build_one()
        truth_path.write_text(truth_path.read_text(encoding="utf-8")
                              .replace("65.0", "66.0"), encoding="utf-8")
        errors = self.check()
        self.assertTrue(any("不一致" in e and "truth_hash" in e for e in errors), errors)

    def test_meta_tamper_fails_check(self):
        make_case(self.datasets, "calibration", "case_a")
        self._build_one()
        meta_path = self.datasets / "calibration" / PROFILE / "case_a.meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["image_sha256"] = "sha256:" + "0" * 64
        meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        errors = self.check()
        self.assertTrue(any("image_sha256" in e for e in errors), errors)

    def test_missing_meta_and_orphan_meta_fail(self):
        make_case(self.datasets, "calibration", "case_a")
        self.assertTrue(any("缺机器生成 meta" in e for e in self.check()))
        self.build()
        orphan = self.datasets / "calibration" / PROFILE / "ghost.meta.json"
        orphan.write_text("{}", encoding="utf-8")
        self.assertTrue(any("孤儿 meta" in e for e in self.check()))

    def test_truth_missing_required_key_fails(self):
        make_case(self.datasets, "calibration", "case_a",
                  truth_overrides={"provenance": None})
        errors = self.build()[1]
        self.assertTrue(any("provenance" in e for e in errors), errors)

    def test_unregistered_field_fails(self):
        make_case(self.datasets, "calibration", "case_a", truth_overrides={
            "fields": {"stage_holding_pressure_bar": [65.0], "mystery_field": 1.0}})
        errors = self.build()[1]
        self.assertTrue(any("未在字段目录登记" in e for e in errors), errors)

    def test_dir_name_must_match_profile_id(self):
        # 目录名与 truth 内 profile_id 不一致（truth 用已登记的 PROFILE）
        src_dir = self.datasets / "calibration" / PROFILE
        make_case(self.datasets, "calibration", "case_a")
        wrong_dir = self.datasets / "calibration" / "demag.injection_metering.other_layout"
        wrong_dir.mkdir(parents=True)
        for artifact in src_dir.glob("case_a*"):
            shutil.move(str(artifact), wrong_dir / artifact.name)
        errors = self.build()[1]
        self.assertTrue(any("目录名" in e and "不符" in e for e in errors), errors)


class PartitionPollutionTest(FixtureMixin, unittest.TestCase):
    def test_duplicate_case_within_partition_fails(self):
        make_case(self.datasets, "calibration", "case_a")
        dup = make_case(self.datasets, "calibration", "case_a_copy",
                        truth_overrides={"case_id": "case_a"})
        errors = self.build()[1]
        self.assertTrue(any("内重复" in e for e in errors), errors)
        dup.unlink()

    def test_cross_partition_duplicate_case_id_fails(self):
        make_case(self.datasets, "calibration", "case_a")
        make_case(self.datasets, "holdout", "case_a")
        errors = self.build()[1]
        self.assertTrue(any("跨分区重复" in e for e in errors), errors)

    def test_cross_partition_duplicate_image_fails(self):
        make_case(self.datasets, "calibration", "case_a", image_bytes=b"same-image")
        make_case(self.datasets, "regression", "case_b", image_bytes=b"same-image")
        errors = self.build()[1]
        self.assertTrue(any("同图不得进两个分区" in e for e in errors), errors)

    def test_calibration_referencing_holdout_fails(self):
        make_case(self.datasets, "holdout", "exam_1")
        make_case(self.datasets, "calibration", "case_a",
                  truth_overrides={"references": ["exam_1"]})
        errors = self.build()[1]
        self.assertTrue(any("引用 holdout case" in e for e in errors), errors)

    def test_regression_referencing_calibration_ok(self):
        make_case(self.datasets, "calibration", "case_a")
        make_case(self.datasets, "regression", "case_b",
                  truth_overrides={"references": ["case_a"]})
        self.assertEqual(self.build()[1], [])


if __name__ == "__main__":
    unittest.main()
