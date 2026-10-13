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
import extract_fields

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
                   y=(row["bbox"][1] + row["bbox"][3]) / (2 * height),
                   bbox=row["bbox"], conf=row["confidence"], line_index=index)
              for index, row in enumerate(fixture["lines"])]
    result = extract_injection_b_and_r(tokens, package["template"])
    truth = json.loads((ROOT / sample["truth_path"]).read_text())
    assert result["warnings"] == []
    assert result["fields"] == truth["fields"]
    observed = result["detail"]["page_observations"]
    assert len(observed["fields"]) == 20
    assert all(row["bbox"] is not None for row in observed["fields"])
    assert all("source_box_unavailable" not in row["reasons"] for row in observed["fields"])
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


def test_z050_template_beats_incidental_lcd_signature(tmp_path, monkeypatch):
    fixture = json.loads((ROOT / "tests/fixtures/b_and_r_z050_rank01_ocr.json").read_text())
    stem = "Z050_rank01"
    lines = []
    for row in fixture["lines"]:
        x0, y0, x1, y1 = row["bbox"]
        lines.append({"text": row["text"], "conf": row["confidence"],
                      "bbox": {"x_min": x0, "y_min": y0, "x_max": x1, "y_max": y1}})
    (tmp_path / f"{stem}.ocr.json").write_text(json.dumps({"lines": lines}))
    (tmp_path / f"{stem}.rectify.json").write_text(json.dumps({
        "ok": True, "screen_size": fixture["screen_size"]}))
    # An auxiliary OCR pass can misread a numeric cell as an LCD SET suffix.
    # Complete physical-page anchors must still win over that weak signature.
    sidecar = [{"text": text, "bbox": {"y_min": y, "y_max": y + 0.01}}
               for text, y in (("100", 0.2), ("99SET", 0.4))]
    (tmp_path / f"{stem}.ocr_mt.json").write_text(json.dumps({"lines": sidecar}))
    monkeypatch.setattr(extract_fields, "route_family", lambda *args: ("unknown", "classifier"))
    result = extract_fields.extract_one(stem, tmp_path, None, None, ROOT / "templates")
    assert result["controller_family"] == "B_AND_R"
    assert result["profile_id"] == PID
    assert result["provenance"]["family_source"] == "template_keywords"
    assert len(result["extraction_detail"]["page_observations"]["fields"]) == 20
