"""R04 real-image OCR, HTTP, script and frozen package behavior gate."""

import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from raw_temperature_time import (DEFINITIONS, VERSION, observe_temperature_time_page,
                                  structure_issues, temperature_time_package,
                                  validate_temperature_time_record)

OUTPUT = Path(os.environ.get("AP_GRAPH_OUTPUT_DIR", ROOT / "output/r04"))
SAMPLES = {
    "temperature": ROOT / "datasets/calibration/demag.temperature.screen_order_5/barrel_A02_e54f3633.jpg",
    "temperature_second": ROOT / "datasets/calibration/demag.temperature.screen_order_5/barrel_A02_b24ff33d.jpg",
    "cooling": ROOT / "ground_truth/bole_est/EST2/Luban_1775031270479feaa3644-985f-4b12-93b3-c275b9bbe27c.jpeg",
    "holding": ROOT / "ground_truth/demag_holding/holding_Z002_ab30f6f6.jpeg",
}


@pytest.fixture(scope="module")
def live_pages(tmp_path_factory):
    import cv2
    import httpx
    import hmi_service as service
    from paddleocr import PaddleOCR
    from rectify import rectify

    directory = tmp_path_factory.mktemp("r04-live")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    engine = PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False)
    previous = service.ocr_model, service.is_ready, service.concurrency_semaphore
    pages = {}

    async def request(path, image):
        transport = httpx.ASGITransport(app=service.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://reader") as client:
            return await client.post(path, files={"file": (image.name, image.read_bytes(), "image/jpeg")})

    try:
        service.ocr_model, service.is_ready = engine, True
        for name, image in SAMPLES.items():
            service.concurrency_semaphore = asyncio.Semaphore(1)
            stem = image.stem
            meta = rectify(image, directory / f"{stem}.png", directory / f"{stem}.rectify.json")
            assert meta["ok"]
            assert meta["original_sha256"] == hashlib.sha256(image.read_bytes()).hexdigest()
            lines = []
            for points, (text, confidence) in engine.ocr(str(directory / f"{stem}.png"), cls=False)[0] or []:
                xs, ys = zip(*points)
                lines.append({"text": text, "conf": float(confidence),
                              "bbox": dict(x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))})
            assert lines
            (directory / f"{stem}.ocr.json").write_text(json.dumps({"lines": lines}))
            command = [sys.executable, "scripts/extract_fields.py", stem,
                       "--rectified-dir", str(directory), "--output-dir", str(directory / "extracted"),
                       "--observations-version", "v2", "--original-image", str(image)]
            process = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=180)
            (OUTPUT / f"{name}-script.log").write_text(process.stdout + process.stderr)
            assert process.returncode == 0, process.stdout + process.stderr
            script = json.loads((directory / "extracted" / f"{stem}.fields.json").read_text())
            response = asyncio.run(request("/api/v1/recognize?observations_version=v2", image))
            assert response.status_code == 200, response.text
            http = response.json()
            service.concurrency_semaphore = asyncio.Semaphore(1)
            legacy = asyncio.run(request("/api/v1/recognize", image))
            assert legacy.status_code == 200, legacy.text
            for suffix, document in (("script", script), ("http", http), ("legacy-http", legacy.json()),
                                     ("rectify", meta), ("ocr", lines)):
                (OUTPUT / f"{name}-{suffix}.json").write_text(json.dumps(document, ensure_ascii=False, indent=2))
            pages[name] = dict(script=script, http=http, legacy=legacy.json(), lines=lines, meta=meta,
                               gray=cv2.imread(str(directory / f"{stem}.png"), cv2.IMREAD_GRAYSCALE))
    finally:
        service.ocr_model, service.is_ready, service.concurrency_semaphore = previous
    return pages


def by_key(record):
    return {field["screen_field_key"]: field for field in record["fields"]}


def test_a11_a12_second_photo_retains_nozzle_and_all_timing_cells(live_pages):
    for name in ("temperature", "temperature_second"):
        for surface in ("script", "http"):
            record = live_pages[name][surface]["page_observations"]
            assert record["image_sha256"] == hashlib.sha256(SAMPLES[name].read_bytes()).hexdigest()
            fields = by_key(record)
            for order, (zone, value) in enumerate([("nozzle-1", 350), ("barrel-3", 295),
                                                  ("barrel-2", 290), ("barrel-1", 285),
                                                  ("feed-throat", 60)], 1):
                for role in ("setting", "actual"):
                    field = fields[f"temperature.{zone}.{role}"]
                    assert field["original_value"] == value
                    assert field["order"] == order and field["zone_id"] == zone
                    assert field["state"] == "unknown" and field["reading"] == "known"
                    assert field["original_unit"] in ("℃", "°C")
                    assert field["bbox"] and field["original_bbox"]
            for key, value in [("cold_start.protection.setting", 8),
                               ("cold_start.protection.display", "8:00"),
                               ("temperature.manual_reduction.delay", 0),
                               ("temperature.manual_reduction.display", "0:00")]:
                field = fields[key]
                assert field["original_value"] == value, field
                assert field["effective_unit"] == "min"
                assert field["reading"] == ("known" if field["confidence"] >= .9 else "uncertain"), field
                assert field["state"] == "unknown"
                assert field["original_bbox"] and field["bbox"]
            validate_temperature_time_record(record, temperature_time_package(record["profile_id"]))


def test_a11_actual_reversed_physical_zone_identity(live_pages):
    for surface in ("script", "http"):
        record = live_pages["temperature"][surface]["page_observations"]
        fields = by_key(record)
        assert record["coverage"]["observed_zone_ids"] == ["nozzle-1", "barrel-3", "barrel-2", "barrel-1", "feed-throat"]
        for zone, value, order, source in [("nozzle-1", 350, 1, "nozzle"), ("barrel-3", 295, 2, "barrel"),
                                           ("barrel-2", 290, 3, "barrel"), ("barrel-1", 285, 4, "barrel"),
                                           ("feed-throat", 60, 5, "other")]:
            for role in ("setting", "actual"):
                field = fields[f"temperature.{zone}.{role}"]
                assert field["zone_id"] == zone
                assert field["original_value"] == value
                assert field["order"] == order
                assert field["zone_source"] == source
                assert field["source"] == "image_recognition"
                assert field["state"] == "unknown"
                assert field["original_unit"] in ("℃", "°C")
                assert field["original_bbox"] and field["bbox"]
        validate_temperature_time_record(record, temperature_time_package(record["profile_id"]))


def test_a12_distinct_cooling_and_delay_original_meanings(live_pages):
    for surface in ("script", "http"):
        cooling = by_key(live_pages["cooling"][surface]["page_observations"])
        assert cooling["storage.pre_cooling.duration"]["original_value"] == 3
        assert cooling["mold.cooling.duration"]["original_value"] == 10
        assert cooling["mold.cooling.duration"]["original_unit"] == "s"
        assert cooling["storage.pre_cooling.duration"]["effective_unit"] == "s"
        for field in cooling.values():
            assert field["role"] == "setting" and field["state"] == "unknown"
            assert field["time_kind"] == field["screen_field_key"]
            assert field["original_bbox"]
        temperatures = by_key(live_pages["temperature"][surface]["page_observations"])
        assert temperatures["cold_start.protection.setting"]["original_value"] == 8
        assert temperatures["temperature.manual_reduction.delay"]["original_value"] == 0
        assert temperatures["temperature.manual_reduction.delay"]["time_kind"] != "cooling_time"
        assert temperatures["cold_start.protection.display"]["original_value"] == "8:00"
        assert temperatures["cold_start.protection.display"]["role"] == "unknown"


def test_a04_disabled_residue_unknown_actual_real_ocr(live_pages):
    for surface in ("script", "http"):
        record = live_pages["holding"][surface]["page_observations"]
        fields = by_key(record)
        disabled = fields["holding.velocity.stage-4"]
        assert disabled["original_value"] == 0
        assert disabled["state"] == "disabled" and disabled["reading"] == "known"
        assert disabled["original_bbox"] and disabled["effective_unit"] == "mm/s"
        assert fields["holding.pressure.stage-3"]["state"] == "unknown"
        assert fields["actual.switch_pressure"]["role"] == "actual"


def test_a18_legacy_response_and_frozen_r01_are_preserved(live_pages):
    from raw_page import raw_page_package, PROFILE
    from export_page_package import export_page_package
    assert export_page_package(PROFILE, "0.3.0") == raw_page_package(PROFILE, "0.3.0")
    for page in live_pages.values():
        assert page["http"]["fields"] == page["legacy"]["fields"]
        old = page["legacy"].get("page_observations")
        assert not old or old.get("schema_version") != "page_observations.v2"


def test_a11_reorder_resize_and_duplicate_ocr_headers(live_pages):
    page = live_pages["temperature"]
    profile = "demag.temperature.screen_order_5"
    lines = copy.deepcopy(page["lines"])
    first = next(line for line in lines if line["text"] == "区3")
    second = next(line for line in lines if line["text"] == "区1")
    first["text"], second["text"] = second["text"], first["text"]
    image_hash = hashlib.sha256(SAMPLES["temperature"].read_bytes()).hexdigest()
    changed = observe_temperature_time_page(profile, lines, page["meta"], image_hash)
    fields = by_key(changed)
    assert fields["temperature.barrel-1.setting"]["order"] == 2
    assert fields["temperature.barrel-3.setting"]["order"] == 4
    assert fields["temperature.barrel-1.setting"]["original_value"] == 295
    reduced = [line for line in lines if line["text"] != "区2"]
    record = observe_temperature_time_page(profile, reduced, page["meta"], image_hash)
    assert "barrel-2" not in record["coverage"]["observed_zone_ids"]
    assert not any(field.get("zone_id") == "barrel-2" for field in record["fields"])
    duplicate = observe_temperature_time_page(profile, lines + [copy.deepcopy(first)], page["meta"], image_hash)
    assert any(issue["code"] == "ZONE_IDENTITY_CONFLICT" for issue in duplicate["issues"])
    with pytest.raises(ValueError):
        validate_temperature_time_record(duplicate, temperature_time_package(profile))
    unknown = copy.deepcopy(lines)
    next(line for line in unknown if line["text"] == "区3")["text"] = "区9"
    record = observe_temperature_time_page(profile, unknown, page["meta"], image_hash)
    assert record["coverage"]["status"] == "partial"
    issue = next(issue for issue in record["issues"] if issue["code"] == "ZONE_ID_UNSUPPORTED")
    assert issue["original_label"] == "区9" and issue["bbox"]


def test_a11_duplicate_identity_group_order_and_source_validation(live_pages):
    record = copy.deepcopy(live_pages["temperature"]["http"]["page_observations"])
    package = temperature_time_package(record["profile_id"])
    fields = by_key(record)
    fields["temperature.barrel-1.setting"]["order"] = 2
    assert any(issue["code"] == "ZONE_ORDER_CONFLICT" for issue in structure_issues(record["fields"]))
    with pytest.raises(ValueError, match="RAW_ZONE_STRUCTURE_CONFLICT"):
        validate_temperature_time_record(record, package)
    record = copy.deepcopy(live_pages["temperature"]["http"]["page_observations"])
    record["fields"][0]["zone_source"] = "manual"
    with pytest.raises(ValueError, match="RAW_PHYSICAL_IDENTITY_CONFLICT"):
        validate_temperature_time_record(record, package)
    record = copy.deepcopy(live_pages["cooling"]["http"]["page_observations"])
    record["fields"] = []
    with pytest.raises(ValueError, match="RAW_FIELD_COVERAGE_INCOMPLETE"):
        validate_temperature_time_record(record, temperature_time_package(record["profile_id"]))
    record = copy.deepcopy(live_pages["temperature"]["http"]["page_observations"])
    record["fields"] = [field for field in record["fields"] if field["screen_field_key"] != "temperature.barrel-1.setting"]
    with pytest.raises(ValueError, match="RAW_FIELD_COVERAGE_INCOMPLETE"):
        validate_temperature_time_record(record, package)


def test_a04_missing_low_confidence_units_and_coordinate_truth(live_pages):
    page = live_pages["temperature"]
    lines = copy.deepcopy(page["lines"])
    value = next(line for line in lines if line["text"] == "295")
    value["conf"] = .4
    value["text"] = "563°F"
    profile = "demag.temperature.screen_order_5"
    record = observe_temperature_time_page(profile, lines, page["meta"], hashlib.sha256(SAMPLES["temperature"].read_bytes()).hexdigest())
    fields = by_key(record)
    field = fields["temperature.barrel-3.actual"]
    assert field["original_value"] == 563 and field["original_unit"] == "°F"
    assert field["effective_unit"] == "°F" and field["reading"] == "uncertain"
    assert field["state"] == "unknown"
    assert any(issue["code"] == "UNIT_TEMPLATE_CONFLICT" for issue in record["issues"])
    import cv2
    import numpy as np
    meta = page["meta"]
    width, height = meta["screen_size"]
    inverse = cv2.getPerspectiveTransform(np.array([[0, 0], [width, 0], [width, height], [0, height]], dtype=np.float32),
                                         np.array(meta["screen_quad"], dtype=np.float32))
    box = field["bbox"]
    points = cv2.perspectiveTransform(np.array([[[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]], dtype=np.float32), inverse)[0]
    original = [points[:, 0].min()/meta["original_size"][0]*100, points[:, 1].min()/meta["original_size"][1]*100,
                points[:, 0].max()/meta["original_size"][0]*100, points[:, 1].max()/meta["original_size"][1]*100]
    assert field["original_bbox"] == pytest.approx(original, abs=.15)
    lines.remove(value)
    missing = by_key(observe_temperature_time_page(profile, lines, page["meta"], record["image_sha256"]))["temperature.barrel-3.actual"]
    assert missing["reading"] == "missing" and missing["original_value"] is None
    assert missing["state"] == "unknown"


def test_frozen_export_http_get_and_fresh_process_reopen(live_pages):
    import httpx
    import hmi_service as service
    for profile in DEFINITIONS:
        package = temperature_time_package(profile)
        command = [sys.executable, "scripts/export_page_package.py", profile, VERSION]
        process = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=30)
        assert process.returncode == 0, process.stderr
        assert json.loads(process.stdout) == package
        async def get():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://reader") as client:
                return await client.get(f"/api/v1/page-templates/{profile}/package?version={VERSION}")
        response = asyncio.run(get())
        assert response.status_code == 200, response.text
        assert response.json() == package
        (OUTPUT / f"{profile}-get-package.json").write_text(json.dumps(response.json(), ensure_ascii=False, indent=2))
        saved = OUTPUT / f"{profile}-saved-observation.json"
        record = next(page["http"]["page_observations"] for page in live_pages.values()
                      if page["http"]["page_observations"]["profile_id"] == profile)
        saved.write_text(json.dumps(record, ensure_ascii=False, indent=2))
        validate_temperature_time_record(json.loads(saved.read_text()), json.loads(process.stdout))
        clean = subprocess.run([sys.executable, "-c",
                                "from scripts.export_page_package import export_page_package; "
                                f"print(export_page_package({profile!r}, {VERSION!r})['profile_id'])"],
                               cwd=ROOT, capture_output=True, text=True, timeout=30)
        assert clean.returncode == 0, clean.stderr
        assert clean.stdout.strip() == profile


def test_a12_original_time_units_are_preserved_without_business_conversion(live_pages):
    page = live_pages["cooling"]
    lines = copy.deepcopy(page["lines"])
    value = next(line for line in lines if line["text"] == "10.0s")
    for text, unit in [("10000ms", "ms"), ("10bar", "bar")]:
        value["text"] = text
        record = observe_temperature_time_page("est.storage_cooling.cooling_delay", lines, page["meta"],
                                               hashlib.sha256(SAMPLES["cooling"].read_bytes()).hexdigest())
        field = by_key(record)["mold.cooling.duration"]
        assert field["original_unit"] == field["effective_unit"] == unit
        assert record["coverage"]["status"] == "partial"
        assert any(issue["code"] == "UNIT_TEMPLATE_CONFLICT" for issue in record["issues"])
        assert "standard_value" not in field


def test_a12_missing_clock_does_not_reuse_numeric_setting(live_pages):
    page = live_pages["temperature_second"]
    record = page["http"]["page_observations"]
    lines = [line for line in record["ocr_evidence"]["lines"] if line["text"] != "0:00"]
    changed = observe_temperature_time_page(record["profile_id"], lines, page["meta"], record["image_sha256"])
    fields = by_key(changed)
    assert fields["temperature.manual_reduction.delay"]["original_value"] == 0
    assert fields["temperature.manual_reduction.display"]["original_value"] is None
    assert fields["temperature.manual_reduction.display"]["reading"] == "missing"


def test_a18_previous_package_bytes_and_get_are_retained():
    import httpx
    import hmi_service as service
    from export_page_package import export_page_package

    for profile in DEFINITIONS:
        frozen = json.loads((ROOT / "templates/raw-packages" / profile / "0.4.0.json").read_text())
        package = temperature_time_package(profile, "0.4.0")
        assert package == frozen == export_page_package(profile, "0.4.0")
        archive = ROOT / "templates/raw-recognizers/temperature_time_ocr.v2/0.4.0/scripts/raw_temperature_time.py"
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == package["recognizer"]["files"]["scripts/raw_temperature_time.py"]
        assert temperature_time_package(profile)["recognizer"] != package["recognizer"]

        async def get_previous():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://reader") as client:
                return await client.get(f"/api/v1/page-templates/{profile}/package?version=0.4.0")

        response = asyncio.run(get_previous())
        assert response.status_code == 200, response.text
        assert response.json() == package
