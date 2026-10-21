"""R6 DEMAG live image, controller, package and historical replay behavior."""

import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import hmi_service as service
import page_template_admin as admin
from export_page_package import export_page_package
from raw_contract import canonical_hash, import_raw_package, validate_raw_record
from raw_demag_configuration import configuration_package
from extract_families.demag_configuration import PROFILE, extract_configuration
from raw_temperature_time import structure_issues, validate_temperature_time_record, temperature_time_package

OUTPUT = Path(os.environ.get("AP_GRAPH_OUTPUT_DIR", ROOT / "output/r6_demag"))
PREFIX = "/api/v1/page-templates"
DEFINITION = json.loads((ROOT / "contracts/raw-pages/demag-configuration-1.0.0.json").read_text())
SAMPLES = {sample["sample_id"]: sample for sample in DEFINITION["samples"]}


@pytest.mark.parametrize("sample,main_values", [
    (1, [7.0, 7.0, 0.7, 0.0]),
    (2, [0.7, 0.7, 7.0, 0.0]),
])
def test_a11_metering_real_upload_keeps_four_physical_pressure_cells(upload, sample, main_values):
    directory = ROOT / "datasets/r6_demag/regression/metering_physical_cells"
    image = directory / f"pressure_{sample}.jpg"
    receipt = json.loads(image.with_suffix(".source.json").read_text())
    assert hashlib.sha256(image.read_bytes()).hexdigest() == receipt["sha256"]
    response = upload(image)
    assert response.status_code == 200, response.text
    document = response.json()
    record(f"metering-physical-cells-{sample}-http", document)
    assert document["profile_id"] == "demag.injection_metering.multi_stage_back_pressure"
    assert document["fields"]["stage_back_pressure_bar"] == main_values
    assert document["fields"]["stage_pressure_bar"] == main_values
    assert document["status"] == "review"
    assert any("MOIRE_DECIMAL_SUSPECT" in warning for warning in document["warnings"])
    pressure = [field for field in document["page_observations"]["fields"] if "背压" in field["label"]]
    assert len(pressure) <= 4
    assert [field["stage"] for field in pressure] == list(range(1, len(pressure) + 1))
    assert all(field["bbox"] for field in pressure)


def record(name, value):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / (name + ".json")).write_text(json.dumps(value, ensure_ascii=False, indent=2))


def fields(document):
    return {field["screen_field_key"]: field for field in document["fields"]}


def hint(root=ROOT):
    package = export_page_package(PROFILE, "1.0.0", root)
    return dict(brand="DEMAG", controller_family="DEMAG", interface_generation=None,
                binding_revision=1, pages=[dict(profile_id=PROFILE, version="1.0.0",
                                               package_sha256=canonical_hash(package))])


@pytest.fixture(scope="module")
def engine():
    from paddleocr import PaddleOCR

    models = OUTPUT / "models"
    return PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False,
                     det_model_dir=str(models / "det"), rec_model_dir=str(models / "rec"),
                     cls_model_dir=str(models / "cls"))


@pytest.fixture(scope="module")
def live(engine):
    from rectify import rectify

    OUTPUT.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="r6-demag-live-", dir=OUTPUT))
    images = {key: ROOT / sample["image"] for key, sample in SAMPLES.items()}
    images.update(holding=ROOT / "ground_truth/demag_holding/holding_Z002_ab30f6f6.jpeg",
                  temperature=ROOT / "datasets/calibration/demag.temperature.screen_order_5/barrel_A02_b24ff33d.jpg",
                  unknown=ROOT / "datasets/r6_demag/regression/unsupported_optimization.jpg",
                  metering=ROOT / "datasets/r6_demag/regression/metering.jpg")
    results = {}
    for key, image in images.items():
        meta = rectify(image, directory / (key + ".png"), directory / (key + ".rectify.json"))
        assert meta["ok"], meta
        assert meta["original_sha256"] == hashlib.sha256(image.read_bytes()).hexdigest()
        lines = []
        for points, (text, confidence) in engine.ocr(str(directory / (key + ".png")), cls=False)[0] or []:
            xs, ys = zip(*points)
            lines.append(dict(text=text, conf=float(confidence), bbox=dict(
                x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
        assert lines
        ocr = dict(lines=lines, model="PaddleOCR 2.7.3 PP-OCRv4 CPU")
        (directory / (key + ".ocr.json")).write_text(json.dumps(ocr, ensure_ascii=False))
        results[key] = dict(image=image, lines=lines, meta=meta)
        record(key + "-live-ocr", ocr)
        record(key + "-live-transform", meta)
    return directory, results


@pytest.fixture
def upload(engine, monkeypatch):
    monkeypatch.setattr(service, "ocr_model", engine)
    monkeypatch.setattr(service, "is_ready", True)
    monkeypatch.delenv("HMI_API_KEY", raising=False)

    def request(image, query=None):
        async def send():
            service.concurrency_semaphore = asyncio.Semaphore(1)
            transport = httpx.ASGITransport(app=service.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://reader") as client:
                return await client.post("/api/v1/recognize", params=query or {},
                                         files={"file": ("upload.jpg", image.read_bytes(), "image/jpeg")})
        return asyncio.run(send())

    return request


def test_a17_scope_originals_and_frozen_evidence_are_distinct():
    assert DEFINITION["page_identity"]["controller_family"] == "DEMAG"
    assert DEFINITION["controller_model"] is None
    assert DEFINITION["page_identity"]["interface_generation"] is None
    assert len(DEFINITION["fields"]) == 35
    digests = set()
    for sample in SAMPLES.values():
        digest = hashlib.sha256((ROOT / sample["image"]).read_bytes()).hexdigest()
        assert digest == sample["image_sha256"]
        digests.add(digest)
        truth = json.loads((ROOT / sample["truth"]).read_text())
        assert truth["image_sha256"] == digest
        assert set(truth["values"]) == {field["screen_field_key"] for field in DEFINITION["fields"]}
        assert (ROOT / sample["image"]).with_suffix(".source.json").is_file()
    assert len(digests) == 4
    assert SAMPLES["reserved"]["purpose"] == "diagnostic_regression"
    assert SAMPLES["acceptance"]["purpose"] == "diagnostic_regression"
    assert SAMPLES["holdout"]["purpose"] == "reserved_acceptance"


@pytest.mark.parametrize("key", ["development", "reserved", "acceptance", "holdout"])
def test_a04_a11_a17_live_http_cli_keep_original_values_and_physical_identity(key, live, upload):
    directory, pages = live
    image = pages[key]["image"]
    process = subprocess.run([sys.executable, "scripts/extract_fields.py", key,
                              "--rectified-dir", str(directory), "--output-dir", str(directory / "extracted"),
                              "--observations-version", "v2", "--original-image", str(image)],
                             cwd=ROOT, text=True, capture_output=True, timeout=90)
    (OUTPUT / (key + "-cli.log")).write_text(process.stdout + process.stderr)
    assert process.returncode == 0, process.stdout + process.stderr
    script = json.loads((directory / "extracted" / (key + ".fields.json")).read_text())
    response = upload(image, {"observations_version": "v2", "controller_hint": json.dumps(hint())})
    assert response.status_code == 200, response.text
    http = response.json()
    record(key + "-http", http)
    record(key + "-cli", script)
    assert http["compatibility"]["status"] == "compatible"
    truth = json.loads((ROOT / SAMPLES[key]["truth"]).read_text())["values"]
    for document in (script, http):
        assert document["profile_id"] == PROFILE
        observation = document["page_observations"]
        validate_raw_record(observation, configuration_package())
        assert observation["image_sha256"] == hashlib.sha256(image.read_bytes()).hexdigest()
        actual = fields(observation)
        assert len(actual) == 35 and observation["coverage"]["status"] == "partial"
        assert all(field["state"] == "unknown" for field in actual.values())
        for field_key, expected in truth.items():
            field = actual[field_key]
            if field["reading"] == "known":
                assert field["original_value"] == expected, field
                assert field["bbox"] and field["original_bbox"]
            elif expected is None:
                assert field["reading"] == "unsupported" and field["original_value"] is None
        expected_missing = {"development": set(),
            "reserved": {"temperature.barrel-1.actual", "temperature.barrel-1.setting"},
            "acceptance": {"actual.carriage", "metering.pressure.setting"},
            "holdout": {"actual.pressure", "actual.position", "actual.carriage", "metering.position.setting",
                        "switch.time.actual"}}
        assert {field_key for field_key, field in actual.items() if field["reading"] == "missing"} == expected_missing[key]
        for field_key in ("cooling.time.setting", "holding.time.setting", "switch.time.setting",
                          "switch.time.actual", "actual.pressure", "actual.position"):
            if field_key not in expected_missing[key]:
                assert actual[field_key]["original_value"] == truth[field_key]
        assert actual["cooling.time.setting"]["original_value"] == (9 if key == "holdout" else 8)
        assert actual["holding.time.setting"]["original_value"] == 2
        assert actual["switch.time.setting"]["original_value"] == 0
        assert actual["switch.time.actual"]["role"] == "actual"
        assert actual["metering.speed.setting"]["original_unit"] == "mm/s"
        assert actual["metering.speed.setting"]["original_value"] == (350 if key == "holdout" else 300)
        assert actual["temperature.barrel-3.setting"]["zone_id"] == "barrel-3"
        assert actual["temperature.barrel-3.setting"]["order"] == 2
        assert actual["temperature.barrel-1.actual"]["role"] == "actual"
        if key == "reserved":
            field = actual["metering.pressure.setting"]
            assert field["text"] == "07" and field["original_value"] == 7
            assert field["reading"] == "uncertain"
        if key == "acceptance":
            field = actual["injection.pressure.setting"]
            assert field["text"] == "992" and field["original_value"] == 992
            assert field["reading"] == "uncertain"
        if key == "holdout":
            for field_key in ("switch.pressure.setting", "injection.pressure.setting", "metering.pressure.setting"):
                assert actual[field_key]["original_value"] is None
                assert actual[field_key]["reading"] == "conflict"
            for field_key in ("holding.pressure.setting", "switch.pressure.actual"):
                field = actual[field_key]
                assert field["original_unit"] == field["effective_unit"] == "bar spez"
                assert field["reading"] == "conflict"


def test_a04_missing_low_conflict_unit_and_unknown_are_independent(live):
    _, pages = live
    page = pages["development"]
    template = export_page_package(PROFILE, "1.0.0")["template"]
    baseline = extract_configuration(page["lines"], template, page["meta"])["detail"]["page_observations"]
    target = fields(baseline)["holding.time.setting"]
    index = target["line_indexes"][0]
    for variant, expected in (("missing", "missing"), ("low", "uncertain"),
                              ("duplicate", "conflict"), ("unit", "conflict")):
        lines = copy.deepcopy(page["lines"])
        if variant == "missing":
            lines.pop(index)
        elif variant == "low":
            lines[index]["conf"] = .2
        elif variant == "duplicate":
            lines.append({**lines[index], "text": "9.000"})
        else:
            lines[index]["text"] = "2.000mm"
        observed = extract_configuration(lines, template, page["meta"])["detail"]["page_observations"]
        field = fields(observed)["holding.time.setting"]
        assert field["reading"] == expected and field["state"] == "unknown"
        if variant in ("missing", "duplicate"):
            assert field["original_value"] is None
        if variant == "unit":
            assert field["original_unit"] == field["effective_unit"] == "mm"
            assert any(issue["code"] == "UNIT_TEMPLATE_CONFLICT" for issue in observed["issues"])
    lines = page["lines"] + [next(line for line in page["lines"] if line["text"] == "保压切换条件")]
    result = extract_configuration(lines, template, page["meta"])
    assert result["fields"] is None and result["warnings"] == ["CONFIGURATION_ANCHOR_CONFLICT"]


def test_a04_a11_a18_existing_holding_and_temperature_real_uploads(live, upload):
    _, pages = live
    results = {}
    for key in ("holding", "temperature"):
        response = upload(pages[key]["image"], {"observations_version": "v2"})
        assert response.status_code == 200, response.text
        result = response.json()
        record(key + "-regression-http", result)
        results[key] = result
    holding = fields(results["holding"]["page_observations"])
    assert holding["holding.velocity.stage-4"]["original_value"] == 0
    assert holding["holding.velocity.stage-4"]["state"] == "disabled"
    assert holding["holding.velocity.stage-4"]["original_bbox"]
    assert holding["holding.pressure.stage-3"]["state"] == "unknown"
    assert holding["actual.switch_pressure"]["role"] == "actual"
    assert holding["actual.switch_pressure"]["original_value"] == 38
    assert holding["holding.pressure.stage-1"]["order"] > holding["holding.pressure.stage-3"]["order"]
    temperature = results["temperature"]["page_observations"]
    validate_temperature_time_record(temperature, temperature_time_package(temperature["profile_id"]))
    zones = fields(temperature)
    for zone, order, value in (("barrel-3", 2, 295), ("barrel-2", 3, 290), ("barrel-1", 4, 285)):
        assert zones[f"temperature.{zone}.setting"]["order"] == order
        assert zones[f"temperature.{zone}.setting"]["original_value"] == value
    duplicate = copy.deepcopy(temperature)
    duplicate["fields"].append(copy.deepcopy(duplicate["fields"][0]))
    assert structure_issues(duplicate["fields"])
    with pytest.raises(ValueError):
        validate_temperature_time_record(duplicate, temperature_time_package(temperature["profile_id"]))
    legacy = upload(pages["holding"]["image"])
    assert legacy.status_code == 200
    assert legacy.json()["fields"]["stage_holding_pressure_bar"][:2] == [65, 50]
    record("holding-legacy-http", legacy.json())


@pytest.fixture
def isolated(monkeypatch):
    directory = Path(tempfile.mkdtemp(prefix="r6-demag-storage-", dir=OUTPUT))
    shutil.copytree(ROOT / "templates", directory / "templates")
    shutil.copytree(ROOT / "contracts", directory / "contracts")
    monkeypatch.setattr(admin, "ROOT", directory)
    monkeypatch.setattr(service, "HERE", directory)
    return directory


@pytest.mark.parametrize("case,expected", [("wrong", "PAGE_BINDING_MISMATCH"),
    ("generation", "PAGE_BINDING_MISMATCH"), ("hash", "PAGE_PACKAGE_INCOMPATIBLE"),
    ("contract", "EXTRACTOR_CONTRACT_INCOMPATIBLE"), ("disabled", "PAGE_TEMPLATE_DISABLED"),
    ("conflict", "PAGE_TEMPLATE_CONFLICT"), ("unknown", "PAGE_UNKNOWN")])
def test_a07_real_upload_rejects_bound_page_errors_without_fallback(case, expected, live, upload, isolated):
    binding = hint(isolated)
    template_path = isolated / "templates/demag/configuration.json"
    package_path = isolated / "templates/packages" / PROFILE / "1.0.0.json"
    if case in ("wrong", "generation", "hash"):
        if case == "wrong":
            binding["controller_family"] = "B_AND_R"
        elif case == "generation":
            binding["interface_generation"] = "UNVERIFIED_NC4"
        else:
            binding["pages"][0]["package_sha256"] = "0" * 64
    elif case in ("disabled", "contract"):
        template = json.loads(template_path.read_text())
        template["enabled" if case == "disabled" else "contract_version"] = False if case == "disabled" else "999.0.0"
        template_path.write_text(json.dumps(template))
        if case == "contract":
            package = json.loads(package_path.read_text())
            package["template"] = template
            package_path.write_text(json.dumps(package))
            binding["pages"][0]["package_sha256"] = canonical_hash(package)
    elif case == "conflict":
        package = json.loads(package_path.read_text())
        other = copy.deepcopy(package)
        other_id = "demag.injection_metering.conflicting_configuration"
        other.update(profile_id=other_id)
        other["template"]["profile_id"] = other_id
        path = isolated / "templates/conflicting.json"
        path.write_text(json.dumps(other["template"]))
        frozen = isolated / "templates/packages" / other_id
        frozen.mkdir()
        (frozen / "1.0.0.json").write_text(json.dumps(other))
        registry = json.loads((isolated / "contracts/profiles.json").read_text())
        registry["profiles"].append(dict(profile_id=other_id, template="conflicting.json"))
        (isolated / "contracts/profiles.json").write_text(json.dumps(registry))
        binding["pages"].append(dict(profile_id=other_id, version="1.0.0", package_sha256=canonical_hash(other)))
    image = live[1]["unknown" if case == "unknown" else "development"]["image"]
    response = upload(image, {"controller_hint": json.dumps(binding)})
    assert response.status_code == 200, response.text
    result = response.json()
    record("a07-" + case, result)
    assert result["compatibility"]["code"] == expected, result
    assert not result.get("fields")
    assert result.get("profile_id") != "generic.spatial"


def test_a18_http_package_get_fresh_process_readback_and_legacy_hashes(monkeypatch):
    monkeypatch.setattr(admin, "ROOT", ROOT)
    app = FastAPI()
    app.include_router(admin.router)
    pairs = [(PROFILE, "1.0.0"), ("demag.injection_metering.multi_stage_holding", "0.3.0"),
             ("demag.temperature.screen_order_5", "0.4.0"), ("demag.temperature.screen_order_5", "0.4.1")]
    receipts = []
    for profile, version in pairs:
        expected = export_page_package(profile, version)
        for _ in range(2):
            with TestClient(app) as reopened:
                response = reopened.get(f"{PREFIX}/{profile}/package", params={"version": version})
            assert response.status_code == 200, response.text
            assert import_raw_package(response.json()) == expected
        process = subprocess.run([sys.executable, "scripts/export_page_package.py", profile, version],
                                 cwd=ROOT, capture_output=True, text=True, timeout=30)
        assert process.returncode == 0, process.stderr
        assert json.loads(process.stdout) == expected
        receipts.append(dict(profile_id=profile, version=version, sha256=canonical_hash(expected)))
    record("package-get-fresh-process-readback", receipts)


def test_a11_existing_zone_reorder_count_and_identity_conflicts(live):
    from raw_temperature_time import observe_temperature_time_page

    page = live[1]["temperature"]
    observation = observe_temperature_time_page("demag.temperature.screen_order_5", page["lines"],
        page["meta"], hashlib.sha256(page["image"].read_bytes()).hexdigest())
    from raw_page_ocr import engine_identity
    observation["engine"] = dict(library="provided_live_ocr", version="2.7.3")
    package = temperature_time_package(observation["profile_id"])
    changed = copy.deepcopy(observation)
    orders = {"nozzle-1": 1, "barrel-1": 2, "barrel-2": 3, "barrel-3": 4, "feed-throat": 5}
    for field in changed["fields"]:
        if field.get("zone_id"):
            field["order"] = orders[field["zone_id"]]
    validate_temperature_time_record(changed, package)
    assert fields(changed)["temperature.barrel-3.setting"]["zone_id"] == "barrel-3"
    assert fields(changed)["temperature.barrel-3.setting"]["order"] == 4
    fewer = copy.deepcopy(changed)
    fewer["fields"] = [field for field in fewer["fields"] if field.get("zone_id") != "barrel-2"]
    validate_temperature_time_record(fewer, package)
    duplicate_order = copy.deepcopy(changed)
    for field in duplicate_order["fields"]:
        if field.get("zone_id") == "barrel-1":
            field["order"] = 4
    with pytest.raises(ValueError, match="RAW_ZONE_STRUCTURE_CONFLICT"):
        validate_temperature_time_record(duplicate_order, package)
    record("a11-zone-boundary-reorder-count-conflict", dict(
        basis="Controlled perturbations of this run's live OCR observation; not additional photographed layouts",
        reordered=changed, fewer=fewer, duplicate_order=duplicate_order))


def test_a18_existing_metering_real_upload_and_injection_frozen_replay(live, upload):
    response = upload(live[1]["metering"]["image"])
    assert response.status_code == 200, response.text
    result = response.json()
    record("metering-regression-http", result)
    assert result["profile_id"] == "demag.injection_metering.multi_stage_back_pressure"
    assert result["fields"]["stage_back_pressure_bar"] == [.7, .7, .7, 0]
    assert result["fields"]["stage_plasticizing_speed_rpm"] == [300, 300, 300, 59]
    observations = result["page_observations"]["fields"]
    assert next(field for field in observations if field["label"] == "预塑转速1")["unit"] == "mm/s"
    from test_demag_injection_page_package import test_injection_page_routes_and_exports_reviewed_sample
    test_injection_page_routes_and_exports_reviewed_sample()
    record("injection-regression-scope", dict(surface="Existing frozen OCR replay only",
        profile_id="demag.injection_metering.multi_stage_injection", version="0.1.0",
        not_verified="No original injection-page image is bundled for this historical fixture. No live injection-page result is claimed."))


def test_a07_a18_controlled_publish_disable_and_old_package_get(upload, live, monkeypatch):
    directory = Path(tempfile.mkdtemp(prefix="r6-demag-publication-", dir=OUTPUT))
    (directory / "contracts").mkdir()
    (directory / "contracts/profiles.json").write_text('{"profiles": []}')
    monkeypatch.setattr(admin, "ROOT", directory)
    monkeypatch.setattr(service, "HERE", directory)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "r6-test-publication")
    app = FastAPI()
    app.include_router(admin.router)
    package = export_page_package(PROFILE, "1.0.0")
    headers = {"Authorization": "Bearer r6-test-publication"}
    path = f"{PREFIX}/drafts/{PROFILE}"
    with TestClient(app) as client:
        payload = dict(expected_version=None, template=package["template"], samples=package["samples"])
        assert client.put(path, json=payload).status_code == 401
        assert not (directory / "templates").exists()
        response = client.put(path, json=payload, headers=headers)
        assert response.status_code == 200, response.text
        trial = client.post(path + "/trial", json=dict(expected_revision=1), headers=headers)
        assert trial.status_code == 200, trial.text
        response = client.post(path + "/publish", json=dict(expected_revision=1,
            expected_version=None, confirmation="publish_confirmed"), headers=headers)
        assert response.status_code == 200, response.text
        old_bytes = (directory / "templates/packages" / PROFILE / "1.0.0.json").read_bytes()
        old_package = client.get(f"{PREFIX}/{PROFILE}/package", params={"version": "1.0.0"}).json()
        disabled = copy.deepcopy(package["template"])
        disabled.update(version="1.0.1", enabled=False)
        response = client.put(path, json=dict(expected_version="1.0.0", expected_revision=1,
            template=disabled, samples=package["samples"]), headers=headers)
        assert response.status_code == 200, response.text
        response = client.post(path + "/publish", json=dict(expected_revision=2,
            expected_version="1.0.0", confirmation="publish_confirmed"), headers=headers)
        assert response.status_code == 200, response.text
    binding = dict(brand="DEMAG", controller_family="DEMAG", interface_generation=None,
        binding_revision=1, pages=[dict(profile_id=PROFILE, version="1.0.0", package_sha256=canonical_hash(old_package))])
    response = upload(live[1]["development"]["image"], dict(observations_version="v2", controller_hint=json.dumps(binding)))
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "PAGE_TEMPLATE_DISABLED"
    with TestClient(app) as reopened:
        response = reopened.get(f"{PREFIX}/{PROFILE}/package", params={"version": "1.0.0"})
        assert response.status_code == 200 and response.json() == old_package
    assert (directory / "templates/packages" / PROFILE / "1.0.0.json").read_bytes() == old_bytes
    record("controlled-publication-disable-old-get", dict(isolated_root=str(directory), trial=trial.json(),
        old_package_sha256=canonical_hash(old_package), result="Published disabled 1.0.1 rejects new recognition with old binding; old 1.0.0 GET retained"))


def test_a11_configuration_missing_and_swapped_headers_preserve_slots(live):
    page = live[1]["development"]
    template = export_page_package(PROFILE, "1.0.0")["template"]
    lines = [line for line in page["lines"] if line["text"] != "区3"]
    missing = fields(extract_configuration(lines, template, page["meta"])["detail"]["page_observations"])
    assert missing["temperature.barrel-3.setting"]["reading"] == "missing"
    assert missing["temperature.barrel-2.setting"]["order"] == 3
    assert missing["temperature.barrel-1.setting"]["order"] == 4
    assert missing["temperature.feed-throat.setting"]["order"] == 5
    swapped = copy.deepcopy(page["lines"])
    for line in swapped:
        if line["text"] in ("区1", "区3"):
            line["text"] = "区3" if line["text"] == "区1" else "区1"
    observed = fields(extract_configuration(swapped, template, page["meta"])["detail"]["page_observations"])
    assert observed["temperature.barrel-3.setting"]["original_value"] == 285
    assert observed["temperature.barrel-3.setting"]["order"] == 4
    assert observed["temperature.barrel-1.setting"]["original_value"] == 295
    assert observed["temperature.barrel-1.setting"]["order"] == 2
    duplicate = copy.deepcopy(page["lines"])
    for line in duplicate:
        if line["text"] == "区1":
            line["text"] = "区3"
    conflict = extract_configuration(duplicate, template, page["meta"])["detail"]["page_observations"]
    assert fields(conflict)["temperature.barrel-3.setting"]["original_value"] is None
    assert any(issue["code"] == "ZONE_IDENTITY_CONFLICT" for issue in conflict["issues"])
