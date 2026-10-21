"""Existing YIZUMI behavior only; live-image and new-page acceptance remain separate."""

import hashlib
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import page_template_admin as admin
from controller_binding import content_hash
from export_page_package import export_page_package
from extract_fields import extract_one

P11 = "yizumi.injection_metering.injection_holding_f2"
P12 = "yizumi.injection_metering.metering_f2"
SAMPLES = [(P11, "P11_31_20260930"), (P11, "P11_31_20260929"),
           (P12, "P12_31_20260930")]


def replay_sample(directory, profile, sample_id, mutate=None, hint=None, templates=None):
    manifest = json.loads((ROOT / "templates/samples" / profile / f"{sample_id}.json").read_text())
    fixture = ROOT / manifest["ocr_fixture"]
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == manifest["ocr_sha256"]
    ocr = json.loads(fixture.read_text())
    if mutate:
        mutate(ocr["lines"])
    (directory / "sample.ocr.json").write_text(json.dumps(ocr))
    meta = {key: manifest[key] for key in ("screen_size", "original_size", "screen_quad")}
    meta.update(ok=True, method=manifest["rectify_method"])
    (directory / "sample.rectify.json").write_text(json.dumps(meta))
    return extract_one("sample", directory, None, None, templates or ROOT / "templates",
                       controller_hint=hint)


@pytest.mark.parametrize("profile,sample_id", SAMPLES)
def test_a04_a18_known_and_missing_readings_retain_unknown_state(tmp_path, profile, sample_id):
    result = replay_sample(tmp_path, profile, sample_id)
    assert result["profile_id"] == profile
    assert result["status"] == "review"
    assert result["fields"] == {}
    fields = result["extraction_detail"]["page_observations"]["fields"]
    assert fields
    assert all(field["state"] == "unknown" and field["state_basis"] is None for field in fields)
    known = [field for field in fields if field["value"] is not None]
    missing = [field for field in fields if field["value"] is None]
    assert known and missing
    assert all(field["bbox"] and field["original_bbox"] for field in known)
    assert all(field["bbox"] is None for field in missing)
    by_label = {field["label"]: field for field in fields}
    if profile == P12:
        assert by_label["熔胶速度2"]["value"] == 75.0
        assert by_label["熔胶速度2"]["unit"] == "%"
        assert by_label["熔胶背压1"]["value"] is None
        assert all(field["role"] == "unknown" for field in fields)
    else:
        assert by_label["射胶压力1"]["value"] == (100.0 if sample_id.endswith("0930") else 140.0)
        assert by_label["射胶压力1"]["unit"] == "bar"
        assert by_label["射胶压力1"]["role"] == "unknown"
        assert by_label["保压速度1"]["role"] == "setting"


def test_a04_low_confidence_does_not_become_disabled_or_zero(tmp_path):
    original = replay_sample(tmp_path, P11, SAMPLES[0][1])
    baseline = next(field for field in original["extraction_detail"]["page_observations"]["fields"]
                    if field["label"] == "射胶压力1")

    def lower_confidence(lines):
        selected = lines[baseline["line_indexes"][-1]]
        assert selected["text"] == baseline["text"]
        selected["conf"] = .2

    result = replay_sample(tmp_path, P11, SAMPLES[0][1], mutate=lower_confidence)
    field = next(field for field in result["extraction_detail"]["page_observations"]["fields"]
                 if field["label"] == "射胶压力1")
    assert baseline["value"] == 100.0
    assert field["value"] is None
    assert field["state"] == "unknown"
    assert field["role"] == "unknown"
    assert "value_missing_or_ambiguous" in field["reasons"]


def test_a11_printed_stage_identity_survives_reverse_order(tmp_path):
    result = replay_sample(tmp_path, P11, SAMPLES[0][1])
    fields = result["extraction_detail"]["page_observations"]["fields"]
    pressure = [field for field in fields if field["label"].startswith("射胶压力")]
    assert [(field["stage"], field["value"]) for field in pressure] == [
        (3, 90.0), (2, 95.0), (1, 100.0)]
    assert [field["bbox"][0] for field in pressure] == sorted(field["bbox"][0] for field in pressure)


@pytest.mark.parametrize("profile,sample_id,label,code", [
    (P11, "P11_31_20260930", "一段", "YIZUMI_STAGE_IDENTITY_CONFLICT"),
    (P12, "P12_31_20260930", "熔胶1", "YIZUMI_STAGE_IDENTITY_CONFLICT"),
    (P12, "P12_31_20260930", "速度", "YIZUMI_ROW_IDENTITY_CONFLICT"),
])
def test_a11_duplicate_identity_reports_conflict_without_overwriting(
        tmp_path, profile, sample_id, label, code):
    evidence_indexes = []

    def duplicate_label(lines):
        index = next(index for index, line in enumerate(lines) if line["text"] == label)
        evidence_indexes.extend([index, len(lines)])
        lines.append(dict(lines[index]))

    result = replay_sample(tmp_path, profile, sample_id, mutate=duplicate_label)
    assert code in result["warnings"]
    assert not result.get("fields")
    assert not any("GENERIC_FALLBACK" in warning for warning in result["warnings"])
    observation = result["extraction_detail"]["page_observations"]
    issue = next(issue for issue in observation["issues"] if issue["code"] == code)
    assert issue["line_indexes"] == evidence_indexes
    if profile == P11:
        assert result["status"] == "review"
        assert issue["section"] == "injection"
        assert issue["stage_ids"] == [1]
        assert all(field["section"] == "holding" for field in observation["fields"])
        assert {field["label"]: field["value"] for field in observation["fields"]} == {
            "保压压力1": 80.0, "保压速度1": 5.0, "保压时间1": 4.0}
    else:
        assert result["status"] == "reject"
        assert issue["section"] == "plasticizing"
        assert observation["fields"] == []
        if label == "熔胶1":
            assert issue["stage_ids"] == [1]
        else:
            assert issue["labels"] == ["速度"]


@pytest.mark.parametrize("profile", [P11, P12])
@pytest.mark.parametrize("invalid", ["unverified_controller", "wrong_hash", "unknown_controller"])
def test_a07_binding_cannot_force_legacy_page_success(tmp_path, profile, invalid):
    package = export_page_package(profile, "0.1.0", ROOT)
    hint = dict(brand="YIZUMI", controller_family="YIZUMI", interface_generation=None,
                binding_revision=1, pages=[dict(profile_id=profile, version="0.1.0",
                                                package_sha256=content_hash(package))])
    expected = "CONTROLLER_METADATA_UNVERIFIED"
    if invalid == "wrong_hash":
        hint["pages"][0]["package_sha256"] = "0" * 64
        expected = "PAGE_PACKAGE_INCOMPATIBLE"
    elif invalid == "unknown_controller":
        hint["pages"][0]["profile_id"] = "yizumi.unregistered.layout"
        expected = "CONTROLLER_UNKNOWN"
    sample_id = next(sample for candidate, sample in SAMPLES if candidate == profile)
    result = replay_sample(tmp_path, profile, sample_id, hint=hint)
    assert result["status"] == "reject"
    assert result["compatibility"]["code"] == expected
    assert not result.get("fields")
    assert not any("GENERIC_FALLBACK" in warning for warning in result["warnings"])


def test_a07_disabled_page_does_not_fall_back(tmp_path):
    templates = tmp_path / "templates"
    (templates / "yizumi").mkdir(parents=True)
    (tmp_path / "contracts").mkdir()
    candidate = json.loads((ROOT / "templates/yizumi/injection_holding.json").read_text())
    candidate["enabled"] = False
    (templates / "yizumi/injection_holding.json").write_text(json.dumps(candidate))
    (templates / "b_and_r.injection_metering.json").write_bytes(
        (ROOT / "templates/b_and_r.injection_metering.json").read_bytes())
    (tmp_path / "contracts/profiles.json").write_text(json.dumps({"profiles": [
        {"profile_id": P11, "template": "yizumi/injection_holding.json"}]}))
    result = replay_sample(tmp_path, P11, SAMPLES[0][1], templates=templates)
    assert result["status"] == "reject"
    assert result["warnings"] == ["PAGE_TEMPLATE_DISABLED"]
    assert not result.get("fields")


@pytest.mark.parametrize("profile,expected_count", [(P11, 2), (P12, 1)])
def test_a17_a18_package_get_reopens_without_recognition(monkeypatch, profile, expected_count):
    monkeypatch.setattr(admin, "ROOT", ROOT)

    def reject_recognition(*args, **kwargs):
        pytest.fail("Package GET/reopen invoked recognition")

    monkeypatch.setattr("extract_fields.extract_one", reject_recognition)
    app = FastAPI()
    app.include_router(admin.router)
    url = f"/api/v1/page-templates/{profile}/package?version=0.1.0"
    with TestClient(app) as first:
        response = first.get(url)
        assert response.status_code == 200, response.text
        package = response.json()
    with TestClient(app) as reopened:
        response = reopened.get(url)
        assert response.status_code == 200, response.text
        assert response.json() == package
    assert package == export_page_package(profile, "0.1.0", ROOT)
    assert len(package["samples"]) == expected_count
    original_hashes = set()
    for sample in package["samples"]:
        manifest = sample["manifest"]
        assert manifest["purpose"] == "development_exposed_not_independent_test"
        assert sample["ocr"] == json.loads((ROOT / manifest["ocr_fixture"]).read_text())
        original_hashes.add(manifest["original_sha256"])
    assert len(original_hashes) == expected_count
