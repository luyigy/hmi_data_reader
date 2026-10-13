"""Z050 B&R physical injection/holding page, with its existing six-image truth lineage."""

import json
import sys
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from export_page_package import export_page_package
from contract import attach_contract
from extract_families.b_and_r_injection import extract_injection_b_and_r
from page_template_registry import registered_page_templates

PID = "b_and_r.injection_holding.multi_stage_position_time"


def test_z050_page_routes_exports_and_matches_original_image_truth():
    fixture = json.loads((ROOT / "tests/fixtures/b_and_r_z050_rank01_ocr.json").read_text())
    package = export_page_package(PID, "0.1.1")
    sample = package["samples"][0]["manifest"]
    assert sha256((ROOT / sample["photo_distribution"]).read_bytes()).hexdigest() == sample["original_sha256"]
    matches = registered_page_templates("B_AND_R", ROOT / "templates", page="injection_metering",
                                        lines=fixture["lines"])
    assert [item["profile_id"] for item in matches] == [PID]
    candidate = package["template"]["business_profile_candidate"]
    assert candidate["page_kind"] == "process_settings"
    assert candidate["pressure_basis"] == "hydraulic_pressure"
    assert candidate["injection_pressure_meaning"] == "pressure_setpoint"
    assert candidate["last_injection_end_from_vp"] is True
    assert candidate["vp_switch_mode"] == "position_or_time"
    width, height = fixture["screen_size"]
    tokens = [dict(text=row["text"], x=(row["bbox"][0] + row["bbox"][2]) / (2 * width),
                   y=(row["bbox"][1] + row["bbox"][3]) / (2 * height))
              for row in fixture["lines"]]
    result = extract_injection_b_and_r(tokens, package["template"])
    truth = json.loads((ROOT / sample["truth_path"]).read_text())
    assert result["warnings"] == []
    assert result["fields"] == truth["fields"]
    observed = result["detail"]["page_observations"]
    assert len(observed["fields"]) == 20
    by_label = {row["label"]: row for row in observed["fields"]}
    assert by_label["射胶压力1"]["value"] == 100
    assert by_label["射胶终点位置3"]["value"] == 0
    assert by_label["射胶终点位置3"]["role"] == "unknown"
    assert by_label["保压切换位置"]["value"] == 15.8
    assert by_label["保压切换时间"]["value"] == 2.35
    response = dict(controller_family="B_AND_R", page_type="injection_metering",
                    fields=result["fields"], extraction_detail=result["detail"])
    attach_contract(response)
    assert response["profile_id"] == PID


def test_previous_z050_page_package_is_archived():
    old = export_page_package(PID, "0.1.0")
    assert old["template"]["business_profile_candidate"]["pressure_basis"] is None
