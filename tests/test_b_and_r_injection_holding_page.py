"""Z050 B&R physical injection/holding page, with its existing six-image truth lineage."""

import json
import sys
from hashlib import sha256
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from export_page_package import export_page_package
from contract import attach_contract
from extract_families.b_and_r_injection import extract_injection_b_and_r
from page_template_registry import registered_page_templates
import extract_fields

PID = "b_and_r.injection_holding.multi_stage_position_time"


def test_z050_legacy_and_registered_routes_share_image_adapter(tmp_path):
    from extractor_registry import capabilities

    package = export_page_package(PID, "0.1.1")
    template = package["template"]
    fixture = json.loads((ROOT / "tests/fixtures/b_and_r_z050_rank01_ocr.json").read_text())
    width, height = fixture["screen_size"]
    tokens = [dict(text=row["text"], x=(row["bbox"][0] + row["bbox"][2]) / (2 * width),
                   y=(row["bbox"][1] + row["bbox"][3]) / (2 * height),
                   bbox=row["bbox"], conf=row["confidence"], line_index=index)
              for index, row in enumerate(fixture["lines"])]
    image = np.full((height, width, 3), 220, dtype=np.uint8)
    for row in fixture["lines"]:
        x0, y0, x1, y1 = map(int, row["bbox"])
        if row["text"] not in {"17.0", "12.0", "10.0", "5.0", "8.0", "0.0"}:
            continue
        if not (900 <= y0 <= 920 or 1340 <= y0 <= 1352):
            continue
        image[y0:y1, x0:x1] = 240
        image[y0:y1:2, x0:x1] = 190 if row["text"] == "0.0" else 25
    photo = tmp_path / "z050.png"
    cv2.imwrite(str(photo), image)
    legacy = extract_fields.extract_page_fields(tokens, template, image_path=photo)
    registered = extract_fields.extract_page_fields(
        tokens, {**template, "extractor": "registered_extractor", "extractor_id": "b_and_r.injection_metering"},
        image_path=photo)
    assert registered == legacy
    observations = legacy["detail"]["page_observations"]["fields"]
    assert sum(row["state"] == "enabled" for row in observations) == 18
    assert all(row["state_basis"] == "grayscale_stage_boundary" for row in observations if row["stage"])
    without_image = extract_fields.extract_page_fields(tokens, template)["detail"]["page_observations"]["fields"]
    assert all(row["state"] == "unknown" for row in without_image if row["stage"])
    assert any(entry["extractor_id"] == "b_and_r.injection_metering" and entry["image_support"]
               for entry in capabilities()["extractors"])


def test_z050_visual_stage_boundary_preselects_only_verified_active_rows(tmp_path):
    from extract_families.b_and_r_page_observations import b_and_r_page_observations

    template = export_page_package(PID, "0.1.1")["template"]
    fields = {
        "injection_stages": 3,
        "injection_velocity_pct": [17, 12, 10],
        "injection_pressure_bar": [100, 115, 91],
        "injection_position_mm": [42, 21, 0],
        "holding_stages": 3,
        "holding_velocity_pct": [5, 5, 8],
        "holding_pressure_bar": [33, 32, 30],
        "holding_time_s": [2.2, 2, 1],
        "vp_switch_position_mm": 15.8,
        "vp_switch_time_s": 2.35,
    }
    image = np.full((200, 500, 3), 220, dtype=np.uint8)
    stage_tokens = {}
    for section, y in (("injection", 40), ("holding", 120)):
        tokens = []
        for stage in range(1, 5):
            x = 400 - stage * 90
            box = [x, y, x + 50, y + 25]
            image[y:y + 25, x:x + 50] = 240
            image[y:y + 25:2, x:x + 50] = 25 if stage <= 3 else 190
            tokens.append({"text": "0.0" if stage == 4 else "5.0", "bbox": box, "conf": .99})
        stage_tokens[section] = tokens
    image_path = tmp_path / "z050.png"
    cv2.imwrite(str(image_path), image)
    source_tokens = {source: stage_tokens["injection" if source.startswith("injection_") else "holding"][:3]
                     for source in ("injection_velocity_pct", "injection_pressure_bar", "injection_position_mm",
                                    "holding_velocity_pct", "holding_pressure_bar", "holding_time_s")}
    observed = b_and_r_page_observations(fields, template, source_tokens,
                                         stage_tokens=stage_tokens, image_path=image_path)
    staged = [row for row in observed["fields"] if row["stage"]]
    assert len(staged) == 18
    assert all(row["state"] == "enabled" and row["state_basis"] == "grayscale_stage_boundary"
               for row in staged)
    assert observed["visual_stage_counts"] == {"injection": 3}

    cv2.imwrite(str(image_path), np.full_like(image, 220))
    unverified = b_and_r_page_observations(fields, template, source_tokens,
                                           stage_tokens=stage_tokens, image_path=image_path)
    assert all(row["state"] == "unknown" for row in unverified["fields"] if row["stage"])


def test_z050_holding_two_active_stages_with_only_three_visible_cells(tmp_path):
    from extract_families.b_and_r_page_observations import b_and_r_page_observations

    template = export_page_package(PID, "0.1.1")["template"]
    fields = {
        "holding_stages": 2,
        "holding_velocity_pct": [5, 2],
        "holding_pressure_bar": [35, 45],
        "holding_time_s": [1.5, 1],
    }
    image = np.full((100, 400, 3), 220, dtype=np.uint8)
    tokens = []
    for stage, x in enumerate((300, 200, 100), 1):
        box = [x, 30, x + 50, 60]
        image[30:60, x:x + 50] = 240
        image[30:60:2, x:x + 50] = 25 if stage <= 2 else 190
        tokens.append({"text": "0.0" if stage == 3 else str(fields["holding_velocity_pct"][stage - 1]),
                       "bbox": box, "conf": .99})
    image_path = tmp_path / "holding.png"
    cv2.imwrite(str(image_path), image)
    source_tokens = {source: tokens[:2] for source in
                     ("holding_velocity_pct", "holding_pressure_bar", "holding_time_s")}
    observed = b_and_r_page_observations(fields, template, source_tokens,
                                         stage_tokens={"holding": tokens}, image_path=image_path)
    assert len(observed["fields"]) == 6
    assert all(row["state"] == "enabled" and row["state_basis"] == "grayscale_stage_boundary"
               for row in observed["fields"])


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
