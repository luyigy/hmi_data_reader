"""R01 behavior gate. Live recognition and legacy replay are separate evidence."""

import asyncio
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
PROFILE = "demag.injection_metering.multi_stage_holding"
IMAGE = ROOT / "ground_truth/demag_holding/holding_Z002_ab30f6f6.jpeg"
EVIDENCE = ROOT / "output/r01"


@pytest.fixture(scope="module")
def live_result(tmp_path_factory):
    import httpx
    from paddleocr import PaddleOCR

    sys.path.insert(0, str(ROOT / "scripts"))
    import hmi_service as service
    from rectify import rectify

    image_bytes = IMAGE.read_bytes()
    manifest = json.loads((ROOT / "templates/samples" / PROFILE / "Z002_ab30f6f6.json").read_text())
    assert hashlib.sha256(image_bytes).hexdigest() == manifest["original_sha256"]
    directory = tmp_path_factory.mktemp("r01-live")
    stem = IMAGE.stem
    rectified = directory / f"{stem}.png"
    meta = rectify(IMAGE, rectified, directory / f"{stem}.rectify.json")
    assert meta["ok"], meta
    engine = PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False)
    raw = engine.ocr(str(rectified), cls=False)
    lines = []
    for points, (text, confidence) in raw[0] or []:
        xs, ys = zip(*points)
        lines.append({"text": text, "conf": float(confidence),
                      "bbox": {"x_min": min(xs), "y_min": min(ys),
                               "x_max": max(xs), "y_max": max(ys)}})
    assert lines, "Live OCR returned no text"
    (directory / f"{stem}.ocr.json").write_text(json.dumps({"lines": lines}))
    command = [sys.executable, str(ROOT / "scripts/extract_fields.py"), stem,
               "--rectified-dir", str(directory), "--output-dir", str(directory / "extracted"),
               "--templates-dir", str(ROOT / "templates")]
    cli = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=90)
    assert cli.returncode == 0, cli.stdout + cli.stderr
    script_result = json.loads((directory / "extracted" / f"{stem}.fields.json").read_text())
    previous = service.ocr_model, service.is_ready, service.concurrency_semaphore

    async def recognize():
        service.ocr_model = engine
        service.is_ready = True
        service.concurrency_semaphore = asyncio.Semaphore(1)
        transport = httpx.ASGITransport(app=service.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://reader") as client:
            return await client.post("/api/v1/recognize",
                                     files={"file": (IMAGE.name, image_bytes, "image/jpeg")})

    try:
        response = asyncio.run(recognize())
    finally:
        service.ocr_model, service.is_ready, service.concurrency_semaphore = previous
    assert response.status_code == 200, response.text
    http_result = response.json()
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    for name, value in (("live-script", script_result), ("live-http", http_result),
                        ("live-rectify", meta), ("live-lines", lines)):
        (EVIDENCE / f"{name}.json").write_text(json.dumps(value, ensure_ascii=False, indent=2))
    return script_result, http_result


def test_live_http_and_script_recognize_the_registered_page(live_result):
    script, http = live_result
    assert script["profile_id"] == http["profile_id"] == PROFILE
    assert script["fields"]["stage_holding_pressure_bar"][:2] == [65.0, 50.0]
    assert http["fields"]["stage_holding_pressure_bar"][:2] == [65.0, 50.0]


def test_raw_observations_keep_disabled_residue_and_four_dimensions(live_result):
    _, http = live_result
    observations = http["page_observations"]
    fields = observations["fields"]
    pressure_three = [field for field in fields
                      if field.get("section") == "holding" and field.get("stage") == 3
                      and "压力" in field.get("original_label", field.get("label", ""))]
    assert len(pressure_three) == 1, "Human truth requires the disabled third pressure, including its zero residue"
    field = pressure_three[0]
    assert field.get("original_value", field.get("value")) == 0.0
    assert field.get("source", observations.get("source")) == "image_recognition"
    assert field.get("role") == "setting"
    assert field.get("state") == "disabled"
    assert field.get("reading") == "known"
    assert field.get("original_bbox"), "Disabled values must retain actual image coordinates"
    keys = [field.get("screen_field_key") for field in fields]
    assert all(keys) and len(keys) == len(set(keys))


def test_model_can_import_complete_raw_definition_from_export_offline():
    from scripts.export_page_package import export_page_package

    package = export_page_package(PROFILE, "0.2.1")
    copied = json.loads(json.dumps(package))
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / "exported-package.json").write_text(json.dumps(copied, ensure_ascii=False, indent=2))
    # Frozen v1 packages remain unchanged; a v2 export still has to be implemented.
    definition = copied.get("raw_field_definition")
    assert isinstance(definition, dict), "Export has no offline raw field definition for the Model form"
    fields = definition["fields"]
    keys = [field["screen_field_key"] for field in fields]
    assert keys and len(keys) == len(set(keys))
    assert "web_target" not in json.dumps(definition)
    contract = copied["raw_contract"]
    encoded = json.dumps(contract, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    assert copied["raw_contract_sha256"] == hashlib.sha256(encoded).hexdigest()


def test_v1_frozen_package_replays_without_images_network_or_latest_template(monkeypatch):
    from scripts.export_page_package import export_page_package
    from scripts.extract_families.demag import extract_demag

    package = export_page_package(PROFILE, "0.2.1")
    ocr = package["samples"][0]["ocr"]
    template = package["template"]
    width, height = ocr["screen_size"]
    tokens = [dict(text=line["text"],
                   x=(line["bbox"][0] + line["bbox"][2]) / (2 * width),
                   y=(line["bbox"][1] + line["bbox"][3]) / (2 * height))
              for line in ocr["lines"]]

    def forbidden(*args, **kwargs):
        pytest.fail("Offline replay attempted external IO")

    monkeypatch.setattr(Path, "read_bytes", forbidden)
    monkeypatch.setattr(Path, "read_text", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    actual = extract_demag(tokens, template)
    content = json.dumps(actual, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    assert hashlib.sha256(content).hexdigest() == "eddc3f3f5efa4b466ad7432d1850e8054612d5eda7a8a65e5740100c1b3d1750"
    assert all(field["state"] == "unknown" for field in actual["detail"]["page_observations"]["fields"])
