"""Real OCR fixtures prove one P11 template routes both photos and excludes P12."""

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from extract_fields import extract_one
from classify_ui import find_page, find_ui_family
from contract import attach_contract
from scripts.export_page_package import export_page_package
import page_template_admin as admin


ROOT = Path(__file__).resolve().parents[1]
PROFILE = "yizumi.injection_metering.injection_holding_f2"


def replay(tmp_path, stem, templates=ROOT / "templates"):
    fixture = ROOT / "tests/fixtures" / f"yizumi_{stem}_31_ocr.json"
    (tmp_path / f"{stem}.ocr.json").write_bytes(fixture.read_bytes())
    sample = {"p11": "P11_31_20260930", "p11b": "P11_31_20260929"}.get(stem)
    manifest = json.loads((ROOT / "templates/samples" / PROFILE / f"{sample}.json").read_text()) if sample else {}
    (tmp_path / f"{stem}.rectify.json").write_text(json.dumps({
        "ok": True, "screen_size": manifest.get("screen_size", [1080, 1920]),
        "method": manifest.get("rectify_method", "original_photo"),
        "original_size": manifest.get("original_size", [1080, 1920]),
        "screen_quad": manifest.get("screen_quad", [[0, 0], [1079, 0], [1079, 1919], [0, 1919]]),
    }))
    return extract_one(stem, tmp_path, None, None, templates)


def test_same_layout_auto_routes_to_one_review_only_page(tmp_path):
    first = replay(tmp_path, "p11")
    second = replay(tmp_path, "p11b")
    for result in (first, second):
        assert (result["controller_family"], result["page_type"], result["profile_id"]) == (
            "YIZUMI", "injection_metering", PROFILE)
        assert result["status"] == "review"
        assert result["provenance"]["page_source"] == "template_anchors"
        observations = result["extraction_detail"]["page_observations"]
        assert observations["profile_id"] == PROFILE
        assert all(item["state"] == "unknown" for item in observations["fields"])
        assert all(item["original_bbox"] is not None for item in observations["fields"]
                   if item["value"] is not None)
    first_fields = {item["label"]: item for item in first["extraction_detail"]["page_observations"]["fields"]}
    assert (first_fields["射胶压力1"]["value"], first_fields["保压速度1"]["value"]) == (100.0, 5.0)
    assert first_fields["射胶压力1"]["role"] == "unknown"
    second_fields = {item["label"]: item for item in second["extraction_detail"]["page_observations"]["fields"]}
    assert second_fields["射胶压力1"]["value"] == 140.0
    assert second_fields["射胶位置3"]["value"] is None  # This OCR cell is missing.
    lines = json.loads((ROOT / "tests/fixtures/yizumi_p11_31_ocr.json").read_text())["lines"]
    family, family_confidence = find_ui_family(lines)
    page, page_confidence = find_page(lines)
    attach_contract(first, {"ui_family": family, "ui_family_confidence": family_confidence,
                            "page": page, "page_confidence": page_confidence})
    assert first["profile_confidence"] == 0.9


def test_other_f2_page_does_not_reuse_injection_template(tmp_path):
    result = replay(tmp_path, "p12")
    assert result.get("profile_id") != PROFILE
    assert result["profile_id"] == "yizumi.injection_metering.metering_f2"


def test_disabled_template_stops_collection_even_with_legacy_fallback(tmp_path):
    templates = tmp_path / "templates"
    nested = templates / "yizumi"
    nested.mkdir(parents=True)
    candidate = json.loads((ROOT / "templates/yizumi/injection_holding.json").read_text())
    candidate["enabled"] = False
    (nested / "injection_holding.json").write_text(json.dumps(candidate))
    (templates / "b_and_r.injection_metering.json").write_bytes(
        (ROOT / "templates/b_and_r.injection_metering.json").read_bytes())
    contracts = tmp_path / "contracts"
    contracts.mkdir()
    (contracts / "profiles.json").write_text(json.dumps({"profiles": [{
        "profile_id": PROFILE, "template": "yizumi/injection_holding.json"}]}))
    result = replay(tmp_path, "p11", templates)
    assert result["status"] == "reject"
    assert result["warnings"] == ["PAGE_TEMPLATE_DISABLED"]
    assert "fields" not in result


def test_reader_package_exports_both_pinned_ocr_samples():
    package = export_page_package(PROFILE, "0.1.0", ROOT)
    assert package["profile_id"] == PROFILE
    assert len(package["samples"]) == 2
    assert {sample["manifest"]["purpose"] for sample in package["samples"]} == {
        "development_exposed_not_independent_test"}


def test_admin_can_preview_then_disable_this_page(tmp_path, monkeypatch):
    template_path = tmp_path / "templates/yizumi/injection_holding.json"
    template_path.parent.mkdir(parents=True)
    template_path.write_bytes((ROOT / "templates/yizumi/injection_holding.json").read_bytes())
    registry = tmp_path / "contracts/profiles.json"
    registry.parent.mkdir()
    registry.write_text(json.dumps({"profiles": [{
        "profile_id": PROFILE, "template": "yizumi/injection_holding.json"}]}))
    for source in [*sorted((ROOT / "templates/samples" / PROFILE).glob("*.json")),
                   *(ROOT / "tests/fixtures").glob("yizumi_p11*_31_ocr.json")]:
        target = tmp_path / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    monkeypatch.setattr(admin, "ROOT", tmp_path)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "test-write-key")
    app = FastAPI()
    app.include_router(admin.router)
    client = TestClient(app)
    url = f"/api/v1/page-templates/{PROFILE}"
    template = client.get(url).json()["template"]
    assert template["enabled"] is True
    draft = {**template, "enabled": False}
    body = {"expected_version": "0.1.0", "template": draft, "confirmation": "save_confirmed"}
    headers = {"Authorization": "Bearer test-write-key"}
    preview = client.post(url + "/preview", json=body, headers=headers)
    assert preview.status_code == 200, preview.text
    assert any(item["label"] == "射胶速度1" for item in preview.json()["fields"])
    saved = client.put(url, json=body, headers=headers)
    assert saved.status_code == 200, saved.text
    assert saved.json()["version"] == "0.1.1"
    assert client.get("/api/v1/page-templates").json()[0]["enabled"] is False
    result = replay(tmp_path, "p11", tmp_path / "templates")
    assert result["warnings"] == ["PAGE_TEMPLATE_DISABLED"]


def test_printed_injection_count_has_traceable_ocr_lines(tmp_path):
    for stem in ('p11', 'p11b'):
        result = replay(tmp_path, stem)
        facts = result['extraction_detail']['page_observations']
        assert facts['stage_counts']['injection']['value'] == 3
        assert facts['stage_counts']['injection']['line_indexes']
        assert 'holding' not in facts['stage_counts']  # The photographed number was not read.


def test_uncertain_or_duplicate_printed_count_stays_unobserved():
    from copy import deepcopy
    from extract_families.pages.yizumi_injection_metering_injection_holding_f2 import extract
    lines = json.loads((ROOT / 'tests/fixtures/yizumi_p11_31_ocr.json').read_text())['lines']
    template = json.loads((ROOT / 'templates/yizumi/injection_holding.json').read_text())
    meta = dict(screen_size=[1381, 1400])
    low = deepcopy(lines)
    low[20]['conf'] = .2
    duplicate = deepcopy(lines)
    duplicate.append(deepcopy(duplicate[20]))
    missing = deepcopy(lines)
    missing[19]['text'] = '未读出'
    for changed in (low, duplicate, missing):
        facts = extract(changed, template, meta)['detail']['page_observations']
        assert 'injection' not in facts['stage_counts']
