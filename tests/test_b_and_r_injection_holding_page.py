"""Z050 B&R physical injection/holding page, with its existing six-image truth lineage."""

import json
import sys
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from export_page_package import export_page_package
from extract_families.b_and_r_injection import extract_injection_b_and_r
from page_template_registry import registered_page_templates

PID = "b_and_r.injection_holding.multi_stage_position_time"


def test_z050_page_routes_exports_and_matches_original_image_truth():
    fixture = json.loads((ROOT / "tests/fixtures/b_and_r_z050_rank01_ocr.json").read_text())
    package = export_page_package(PID, "0.1.0")
    sample = package["samples"][0]["manifest"]
    assert sha256((ROOT / sample["photo_distribution"]).read_bytes()).hexdigest() == sample["original_sha256"]
    matches = registered_page_templates("B_AND_R", ROOT / "templates", page="injection_metering",
                                        lines=fixture["lines"])
    assert [item["profile_id"] for item in matches] == [PID]
    candidate = package["template"]["business_profile_candidate"]
    assert candidate["page_kind"] == "process_settings"
    assert candidate["pressure_basis"] is None
    width, height = fixture["screen_size"]
    tokens = [dict(text=row["text"], x=(row["bbox"][0] + row["bbox"][2]) / (2 * width),
                   y=(row["bbox"][1] + row["bbox"][3]) / (2 * height))
              for row in fixture["lines"]]
    result = extract_injection_b_and_r(tokens, package["template"])
    truth = json.loads((ROOT / sample["truth_path"]).read_text())
    assert result["warnings"] == []
    assert result["fields"] == truth["fields"]
