"""Real P12 photo proves an independent YIZUMI page module and switch."""
import json
from pathlib import Path

import pytest

from extract_fields import extract_one
from page_template_admin import list_templates
from scripts.export_page_package import export_page_package


ROOT = Path(__file__).resolve().parents[1]
PROFILE = "yizumi.injection_metering.metering_f2"
P11 = "yizumi.injection_metering.injection_holding_f2"


def replay(tmp_path, sample, templates=ROOT / "templates"):
    if sample == "p12":
        manifest = json.loads((ROOT / "templates/samples" / PROFILE / "P12_31_20260930.json").read_text())
    else:
        manifest = json.loads((ROOT / "templates/samples" / P11 / "P11_31_20260930.json").read_text())
    (tmp_path / f"{sample}.ocr.json").write_bytes((ROOT / manifest["ocr_fixture"]).read_bytes())
    (tmp_path / f"{sample}.rectify.json").write_text(json.dumps({
        "ok": True, "screen_size": manifest["screen_size"],
        "original_size": manifest["original_size"], "screen_quad": manifest["screen_quad"],
        "method": manifest["rectify_method"],
    }))
    return extract_one(sample, tmp_path, None, None, templates)


def test_p12_photo_routes_without_page_id_and_keeps_unsafe_semantics_out_of_settings(tmp_path):
    result = replay(tmp_path, "p12")
    assert (result["controller_family"], result["profile_id"], result["status"]) == (
        "YIZUMI", PROFILE, "review")
    assert result["provenance"]["page_source"] == "template_anchors"
    fields = {item["label"]: item for item in result["extraction_detail"]["page_observations"]["fields"]}
    assert (fields["熔胶位置1"]["value"], fields["熔胶速度2"]["value"]) == (10.0, 75.0)
    assert fields["熔胶速度2"]["unit"] == "%"
    assert fields["熔胶背压1"]["value"] is None  # OCR read the first 5 as a letter.
    assert fields["熔胶背压2"]["value"] == 5.0
    assert all(field["role"] == "unknown" and field["state"] == "unknown" for field in fields.values())
    assert all(field["original_bbox"] is not None for field in fields.values() if field["value"] is not None)
    assert replay(tmp_path, "p11")["profile_id"] == P11


@pytest.mark.parametrize("disabled,remaining", [(PROFILE, P11), (P11, PROFILE)])
def test_one_page_disabled_does_not_block_the_other(tmp_path, disabled, remaining):
    templates = tmp_path / "templates"
    nested = templates / "yizumi"
    nested.mkdir(parents=True)
    registry = tmp_path / "contracts/profiles.json"
    registry.parent.mkdir()
    registry.write_text(json.dumps({"profiles": [
        {"profile_id": P11, "template": "yizumi/injection_holding.json"},
        {"profile_id": PROFILE, "template": "yizumi/metering_f2.json"},
    ]}))
    for name in ("injection_holding", "metering_f2"):
        template = json.loads((ROOT / "templates/yizumi" / f"{name}.json").read_text())
        template["enabled"] = template["profile_id"] != disabled
        (nested / f"{name}.json").write_text(json.dumps(template))
    assert replay(tmp_path, "p12" if disabled == PROFILE else "p11", templates)["warnings"] == [
        "PAGE_TEMPLATE_DISABLED"]
    assert replay(tmp_path, "p11" if remaining == P11 else "p12", templates)["profile_id"] == remaining


def test_p12_has_exportable_independent_version_package():
    package = export_page_package(PROFILE, "0.1.0", ROOT)
    assert package["template"]["profile_id"] == PROFILE
    assert [item["manifest"]["sample_id"] for item in package["samples"]] == ["P12_31_20260930"]
    listed = {item["profile_id"]: item for item in list_templates()}
    assert listed[PROFILE]["enabled"] is True
    assert listed[P11]["enabled"] is True


def test_printed_metering_count_is_evidence_not_role_approval(tmp_path):
    from test_yizumi_injection_holding_page import replay
    facts = replay(tmp_path, 'p12')['extraction_detail']['page_observations']
    assert facts['stage_counts']['plasticizing'] == {'value': 2, 'line_indexes': [5, 6]}
    assert all(item['role'] == 'unknown' for item in facts['fields'])
