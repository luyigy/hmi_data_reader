"""Four real OCR samples route by image, and one legacy page can be switched off."""
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from extract_fields import extract_one
from page_template_admin import TemplateSave, save_template


ROOT = Path(__file__).resolve().parents[1]
P11 = "yizumi.injection_metering.injection_holding_f2"
P12 = "yizumi.injection_metering.metering_f2"
DEMAG_INJECTION = "demag.injection_metering.multi_stage_injection"
DEMAG_HOLDING = "demag.injection_metering.multi_stage_holding"


def replay(tmp_path, sample, templates=ROOT / "templates"):
    if sample in ("p11", "p12"):
        profile, sample_id = (P11, "P11_31_20260930") if sample == "p11" else (P12, "P12_31_20260930")
        manifest = json.loads((ROOT / "templates/samples" / profile / f"{sample_id}.json").read_text())
        ocr = json.loads((ROOT / manifest["ocr_fixture"]).read_text())
        meta = {"ok": True, "screen_size": manifest["screen_size"],
                "original_size": manifest["original_size"], "screen_quad": manifest["screen_quad"]}
    else:
        name = "demag_injection_z002_wehdt_ocr.json" if sample == "demag_injection" else "demag_holding_z002_ocr.json"
        fixture = json.loads((ROOT / "tests/fixtures" / name).read_text())
        width, height = fixture["screen_size"]
        ocr = {"lines": [{"text": item["text"], "conf": item["confidence"],
                          "bbox": dict(zip(("x_min", "y_min", "x_max", "y_max"), item["bbox"]))}
                         for item in fixture["lines"]]}
        meta = {"ok": True, "screen_size": [width, height], "original_size": [width, height],
                "screen_quad": [[0, 0], [width, 0], [width, height], [0, height]]}
    (tmp_path / f"{sample}.ocr.json").write_text(json.dumps(ocr))
    (tmp_path / f"{sample}.rectify.json").write_text(json.dumps(meta))
    return extract_one(sample, tmp_path, None, None, templates)


def isolated_templates(tmp_path, disabled):
    templates = tmp_path / "templates"
    (templates / "yizumi").mkdir(parents=True)
    (templates / "demag").mkdir()
    paths = {P11: "yizumi/injection_holding.json", P12: "yizumi/metering_f2.json",
             DEMAG_INJECTION: "demag/injection.json", DEMAG_HOLDING: "demag/holding.json"}
    for profile, relative in paths.items():
        item = json.loads((ROOT / "templates" / relative).read_text())
        if profile == disabled:
            item["enabled"] = False
        (templates / relative).write_text(json.dumps(item, ensure_ascii=False))
    registry = tmp_path / "contracts/profiles.json"
    registry.parent.mkdir()
    registry.write_text(json.dumps({"profiles": [{"profile_id": profile, "template": relative}
                                                  for profile, relative in paths.items()]}))
    return templates


def test_image_only_routing_distinguishes_yizumi_and_demag_pages(tmp_path):
    expected = {"p11": P11, "p12": P12,
                "demag_injection": DEMAG_INJECTION, "demag_holding": DEMAG_HOLDING}
    for sample, profile in expected.items():
        result = replay(tmp_path, sample)
        assert result["profile_id"] == profile
        assert result["provenance"]["page_source"] == "template_anchors"


@pytest.mark.parametrize("disabled,sample,remaining,other", [
    (P11, "p11", "demag_injection", DEMAG_INJECTION),
    (P12, "p12", "p11", P11),
    (DEMAG_INJECTION, "demag_injection", "demag_holding", DEMAG_HOLDING),
    (DEMAG_HOLDING, "demag_holding", "p12", P12),
])
def test_disabling_one_brand_page_keeps_the_other_brand_running(tmp_path, disabled, sample, remaining, other):
    templates = isolated_templates(tmp_path, disabled)
    assert replay(tmp_path, sample, templates)["warnings"] == ["PAGE_TEMPLATE_DISABLED"]
    assert replay(tmp_path, remaining, templates)["profile_id"] == other


@pytest.mark.parametrize("profile,path,sample", [
    (DEMAG_INJECTION, "demag/injection.json", "demag_injection"),
    (DEMAG_HOLDING, "demag/holding.json", "demag_holding"),
])
def test_legacy_demag_template_can_add_enabled_switch_and_archive_version(tmp_path, profile, path, sample):
    templates = isolated_templates(tmp_path, None)
    source = json.loads((templates / path).read_text())
    bad = TemplateSave(expected_version=source["version"], template={**source, "enabled": "false"},
                       confirmation="save_confirmed")
    with pytest.raises(HTTPException) as exc:
        save_template(profile, bad, tmp_path)
    assert exc.value.status_code == 422
    draft = TemplateSave(expected_version=source["version"], template={**source, "enabled": False},
                         confirmation="save_confirmed")
    saved = save_template(profile, draft, tmp_path)
    major, minor, patch = map(int, source["version"].split("."))
    assert saved["version"] == f"{major}.{minor}.{patch + 1}"
    assert json.loads((tmp_path / "templates/versions" / profile / f"{source['version']}.json").read_text()) == source
    assert replay(tmp_path, sample, templates)["warnings"] == ["PAGE_TEMPLATE_DISABLED"]
    assert replay(tmp_path, "p11", templates)["profile_id"] == P11
    restored = save_template(profile, TemplateSave(expected_version=saved["version"],
        template={**source, "version": saved["version"], "enabled": True},
        confirmation="rollback_confirmed"), tmp_path)
    assert restored["version"] == f"{major}.{minor}.{patch + 2}"
    assert replay(tmp_path, sample, templates)["profile_id"] == profile
