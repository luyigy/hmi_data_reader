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
               "--templates-dir", str(ROOT / "templates"), "--observations-version", "v2",
               "--original-image", str(IMAGE)]
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
            return await client.post("/api/v1/recognize?observations_version=v2",
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
    by_key = {field["screen_field_key"]: field for field in fields}
    field = by_key["holding.velocity.stage-4"]
    assert field.get("original_value", field.get("value")) == 0.0
    assert field.get("source", observations.get("source")) == "image_recognition"
    assert field.get("role") == "setting"
    assert field.get("state") == "disabled"
    assert field.get("reading") == "known"
    assert field.get("original_bbox"), "Disabled values must retain actual image coordinates"
    assert by_key["holding.pressure.stage-3"]["original_value"] == 0.0
    assert by_key["holding.pressure.stage-3"]["state"] == "unknown"
    assert any(issue["code"] == "STATE_TRUTH_CONFLICT" for issue in observations["issues"])
    assert by_key["actual.switch_pressure"]["original_value"] == 38.0
    assert by_key["actual.switch_pressure"]["role"] == "actual"
    assert observations["image_sha256"] == hashlib.sha256(IMAGE.read_bytes()).hexdigest()
    assert observations["schema_version"] == "page_observations.v2"
    for value in fields:
        if value["original_bbox"]:
            x1, y1, x2, y2 = value["original_bbox"]
            assert 0 <= x1 < x2 <= 100 and 0 <= y1 < y2 <= 100
    script = live_result[0]["page_observations"]
    script_by_key = {field["screen_field_key"]: field for field in script["fields"]}
    for key in ("holding.pressure.stage-1", "holding.velocity.stage-4", "actual.switch_pressure"):
        assert script_by_key[key]["original_value"] == by_key[key]["original_value"]
        assert script_by_key[key]["state"] == by_key[key]["state"]
    keys = [field.get("screen_field_key") for field in fields]
    assert all(keys) and len(keys) == len(set(keys))


def test_model_can_import_complete_raw_definition_from_export_offline():
    from scripts.export_page_package import export_page_package

    package = export_page_package(PROFILE, "0.3.0")
    copied = json.loads(json.dumps(package))
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / "exported-package.json").write_text(json.dumps(copied, ensure_ascii=False, indent=2))
    definition = copied.get("raw_field_definition")
    assert isinstance(definition, dict), "Export has no offline raw field definition for the Model form"
    fields = definition["fields"]
    keys = [field["screen_field_key"] for field in fields]
    assert keys and len(keys) == len(set(keys))
    assert "web_target" not in json.dumps(definition)
    contract = copied["raw_contract"]
    encoded = json.dumps(contract, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    assert copied["raw_contract_sha256"] == hashlib.sha256(encoded).hexdigest()
    model_python = "/data1/code/mold-data-webpage-tool/backend/.venv/bin/python"
    program = """
import json, socket, sys
from jsonschema import Draft202012Validator
package = json.load(sys.stdin)
def forbidden(*args, **kwargs):
    raise AssertionError('Offline import used network')
socket.socket.connect = forbidden
Draft202012Validator.check_schema(package['raw_contract'])
definition = package['raw_field_definition']
record = dict(schema_version='page_observations.v2', source='manual', actor='offline-engineer',
              created_at='2026-10-18T12:00:00Z', revision=1, profile_id=package['profile_id'],
              raw_field_definition_sha256=package['raw_field_definition_sha256'], fields=[])
for spec in definition['fields']:
    record['fields'].append(dict(screen_field_key=spec['screen_field_key'], source='manual',
        original_label=spec['label'], original_value=None, original_unit=spec['unit'],
        role=spec['role'], state='unknown', reading='missing', original_bbox=None))
validator = Draft202012Validator(package['raw_contract'])
validator.validate(record)
record['fields'][0]['original_bbox'] = [1, 2, 3, 4]
assert not validator.is_valid(record), 'Manual form accepted fabricated recognition evidence'
print(json.dumps(dict(status='offline_import_passed', fields=len(definition['fields']),
                     schema=package['raw_contract']['$id'])))
"""
    result = subprocess.run([model_python, "-c", program], input=json.dumps(copied),
                            capture_output=True, text=True, timeout=30,
                            cwd="/data1/code/mold-data-webpage-tool/backend")
    assert result.returncode == 0, result.stdout + result.stderr
    (EVIDENCE / "model-offline-import.json").write_text(result.stdout)


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


def test_frozen_definition_covers_every_declared_slot_and_preserves_uncertainty(live_result):
    from scripts.raw_contract import validate_raw_record
    from scripts.export_page_package import export_page_package

    package = export_page_package(PROFILE, "0.3.0")
    expected = {field["screen_field_key"] for field in package["raw_field_definition"]["fields"]}
    for result in live_result:
        observed = result["page_observations"]
        validate_raw_record(observed, package)
        by_key = {field["screen_field_key"]: field for field in observed["fields"]}
        assert set(by_key) == expected
        assert len(expected) == 27
        assert by_key["holding.pressure.stage-4"]["value"] == 0
        assert by_key["holding.pressure.stage-4"]["state"] == "disabled"
        assert by_key["holding.pressure.stage-4"]["original_bbox"]
        assert by_key["holding.duration.stage-3"]["value"] == 0
        assert by_key["holding.duration.stage-3"]["state"] == "disabled"
        assert by_key["status.middle_displacement"]["reading"] == "uncertain"
        assert by_key["holding.multistage_velocity.enabled"]["reading"] == "unsupported"
        assert observed["coverage"]["status"] == "partial"
        pressure = by_key["holding.pressure.stage-1"]
        assert pressure["original_unit"] is None
        assert pressure["effective_unit"] == pressure["template_ref"]["unit"] == "bar"
        assert pressure["template_ref"]["sha256"] == package["raw_field_definition_sha256"]
        assert by_key["holding.velocity.stage-1"]["original_bbox"][0] > by_key["holding.velocity.stage-3"]["original_bbox"][0]
        truth = package["samples"][0]["full_page_transcription"]
        for key, value in truth["values"].items():
            if key in truth["uncertain_ocr"]:
                assert by_key[key]["reading"] == "uncertain"
            else:
                assert by_key[key]["original_value"] == value, key


def test_offline_contract_rejects_tampering_duplicates_and_nonfinite_values(live_result):
    from copy import deepcopy
    from scripts.raw_contract import import_raw_package, validate_raw_record
    from scripts.export_page_package import export_page_package

    package = export_page_package(PROFILE, "0.3.0")
    bad = deepcopy(package)
    bad["raw_field_definition"]["fields"][0]["unit"] = "rpm"
    with pytest.raises(ValueError, match="HASH_MISMATCH"):
        import_raw_package(bad)
    record = deepcopy(live_result[1]["page_observations"])
    record["fields"].append(deepcopy(record["fields"][0]))
    with pytest.raises(ValueError, match="IDENTITY_CONFLICT"):
        validate_raw_record(record, package)
    record = deepcopy(live_result[1]["page_observations"])
    record["fields"][0]["original_value"] = float("nan")
    with pytest.raises(ValueError, match="VALUE_INVALID"):
        validate_raw_record(record, package)
    record = deepcopy(live_result[1]["page_observations"])
    del record["recognizer"]
    with pytest.raises(ValueError, match="PROVENANCE_REQUIRED"):
        validate_raw_record(record, package)
    record = deepcopy(live_result[1]["page_observations"])
    record["package_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="PACKAGE_HASH_MISMATCH"):
        validate_raw_record(record, package)


def test_unfrozen_versions_and_unsupported_pages_are_explicitly_rejected(tmp_path):
    from scripts.export_page_package import export_page_package
    from scripts.raw_page import observe_raw_page

    with pytest.raises(ValueError, match="NOT_FROZEN"):
        export_page_package(PROFILE, "0.3.0", root=tmp_path)
    with pytest.raises(ValueError, match="RAW_PAGE_UNSUPPORTED"):
        observe_raw_page("unknown", [], {}, "a" * 64)


def test_missing_and_low_confidence_do_not_change_source_role_or_state(live_result):
    from copy import deepcopy
    from scripts.raw_page import observe_raw_page

    http = live_result[1]["page_observations"]
    lines = deepcopy(http["ocr_evidence"]["lines"])
    first = next(field for field in http["fields"] if field["screen_field_key"] == "holding.velocity.stage-1")
    source_index = first["line_indexes"][0]
    lines[source_index]["conf"] = .2
    lines[source_index]["confidence"] = .2
    result = observe_raw_page(PROFILE, lines, http["transform"], http["image_sha256"])
    field = next(field for field in result["fields"] if field["screen_field_key"] == first["screen_field_key"])
    assert (field["source"], field["role"], field["state"], field["reading"]) == ("image_recognition", "setting", "unknown", "uncertain")
    lines.pop(source_index)
    result = observe_raw_page(PROFILE, lines, http["transform"], http["image_sha256"])
    field = next(field for field in result["fields"] if field["screen_field_key"] == first["screen_field_key"])
    assert field["reading"] == "missing" and field["original_value"] is None
    assert field["state"] == "unknown" and field["original_bbox"] is None


def test_model_environment_validates_live_record_against_frozen_schema(live_result):
    from scripts.export_page_package import export_page_package

    package = export_page_package(PROFILE, "0.3.0")
    payload = dict(package=package, record=live_result[1]["page_observations"])
    program = """
import json, socket, sys
from jsonschema import Draft202012Validator
document = json.load(sys.stdin)
def forbidden(*args, **kwargs):
    raise AssertionError('Network used in offline validation')
socket.socket.connect = forbidden
validator = Draft202012Validator(document['package']['raw_contract'])
validator.validate(document['record'])
document['record']['fields'][0]['confidence'] = 1.1
assert not validator.is_valid(document['record'])
print('live_record_schema_passed')
"""
    result = subprocess.run(["/data1/code/mold-data-webpage-tool/backend/.venv/bin/python", "-c", program],
                            input=json.dumps(payload), capture_output=True, text=True,
                            cwd="/data1/code/mold-data-webpage-tool/backend", timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    (EVIDENCE / "model-live-schema.txt").write_text(result.stdout)


def test_raw_package_http_get_and_cli_export_reopen_without_ocr(monkeypatch):
    import httpx
    import hmi_service as service

    class NoOCR:
        def ocr(self, *args, **kwargs):
            pytest.fail("Package GET unexpectedly invoked OCR")

    monkeypatch.setattr(service, "ocr_model", NoOCR())

    async def read_package():
        transport = httpx.ASGITransport(app=service.app)
        url = f"/api/v1/page-templates/{PROFILE}/package?version=0.3.0"
        async with httpx.AsyncClient(transport=transport, base_url="http://reader") as client:
            first = await client.get(url)
        async with httpx.AsyncClient(transport=transport, base_url="http://reader") as client:
            second = await client.get(url)
        return first, second

    first, second = asyncio.run(read_package())
    assert first.status_code == second.status_code == 200, first.text
    assert first.json() == second.json()
    command = [sys.executable, "scripts/export_page_package.py", PROFILE, "0.3.0"]
    exported = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=30)
    assert exported.returncode == 0, exported.stderr
    assert json.loads(exported.stdout) == first.json()
    (EVIDENCE / "package-get-reopen.json").write_text(first.text)


def test_manual_import_keeps_optional_image_reference_separate_from_ocr_provenance():
    from copy import deepcopy
    from scripts.export_page_package import export_page_package
    from scripts.raw_contract import validate_raw_record

    package = export_page_package(PROFILE, "0.3.0")
    record = dict(schema_version="page_observations.v2", source="manual", actor="engineer",
                  created_at="2026-10-18T12:00:00Z", revision=1, profile_id=PROFILE,
                  raw_field_definition_sha256=package["raw_field_definition_sha256"],
                  image_reference={"sha256": "a" * 64}, fields=[])
    assert validate_raw_record(record, package) == record
    for patch, error in (({"image_reference": "local/image.jpg"}, "IMAGE_REFERENCE_INVALID"),
                         ({"actor": 123}, "AUDIT_REQUIRED"),
                         ({"image_sha256": None}, "EVIDENCE_FORBIDDEN")):
        invalid = {**deepcopy(record), **patch}
        with pytest.raises(ValueError, match=error):
            validate_raw_record(invalid, package)
