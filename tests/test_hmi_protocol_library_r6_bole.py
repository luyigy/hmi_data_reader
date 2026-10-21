"""R6 BOLE real OCR, raw-page evidence, compatibility and historical replay."""

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

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest
import yaml

import page_template_admin as admin
from scripts.raw_bole_injection import PROFILE, VERSION, bole_injection_package, observe_bole_injection
from scripts.raw_contract import canonical_hash, import_raw_package, validate_raw_record

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ["AP_GRAPH_OUTPUT_DIR"])
PREFIX = "/api/v1/page-templates"


def write_evidence(name, value):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


@pytest.fixture(scope="module")
def engine():
    from paddleocr import PaddleOCR
    from scripts.raw_page_ocr import engine_identity

    cache = OUTPUT / "ocr-model-cache"
    instance = PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False,
                         det_model_dir=str(cache / "det"), rec_model_dir=str(cache / "rec"),
                         cls_model_dir=str(cache / "cls"))
    write_evidence("ocr-engine.json", dict(identity=engine_identity(instance),
        model_files={str(p.relative_to(cache)): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted(cache.rglob("inference.*")) if p.is_file()}))
    return instance


@pytest.fixture(scope="module")
def live(engine):
    from scripts.rectify import rectify
    from scripts.raw_page_ocr import engine_identity

    package = bole_injection_package()
    directory = Path(tempfile.mkdtemp(prefix="r6-live-", dir=OUTPUT))
    result = {}
    for sample in package["raw_field_definition"]["samples"]:
        name = sample["sample_id"]
        image = ROOT / sample["image"]
        assert hashlib.sha256(image.read_bytes()).hexdigest() == sample["image_sha256"]
        meta = rectify(image, directory / f"{name}.png", directory / f"{name}.rectify.json")
        assert meta["ok"], meta
        raw = engine.ocr(str(directory / f"{name}.png"), cls=False)
        lines = []
        for points, (text, confidence) in raw[0] or []:
            xs, ys = zip(*points)
            lines.append(dict(text=text, conf=float(confidence), bbox=dict(
                x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
        assert lines
        ocr = dict(lines=lines, engine_identity=engine_identity(engine))
        (directory / f"{name}.ocr.json").write_text(json.dumps(ocr, ensure_ascii=False, indent=2))
        observation = observe_bole_injection(lines, meta, sample["image_sha256"])
        observation["engine"] = engine_identity(engine)
        validate_raw_record(observation, package)
        record_path = directory / f"{name}.v2.json"
        record_path.write_text(json.dumps(observation, ensure_ascii=False, indent=2))
        model_python = os.environ.get("HMI_MODEL_PYTHON", "/data1/code/mold-data-webpage-tool/backend/.venv/bin/python")
        schema_check = subprocess.run([model_python, "-c",
            "import json,sys,jsonschema; from importlib.metadata import version; "
            "jsonschema.validate(json.load(open(sys.argv[1])),json.load(open(sys.argv[2]))['raw_contract']); "
            "print('jsonschema '+version('jsonschema')+' validates Reader raw record')",
            str(record_path), str(ROOT / "templates/raw-packages" / PROFILE / f"{VERSION}.json")],
            capture_output=True, text=True, timeout=30, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        assert schema_check.returncode == 0, schema_check.stdout + schema_check.stderr
        (directory / f"{name}.model-schema-check.txt").write_text(schema_check.stdout)
        result[name] = dict(spec=sample, meta=meta, ocr=ocr, observation=observation)
    return directory, result


def test_a17_deduplicate_photos_and_inventory_controller_and_field_gaps():
    photos = set()
    for folder in (ROOT / "ground_truth").glob("bole*"):
        photos.update(p for p in folder.rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    for folder in (ROOT / "datasets").rglob("*"):
        if folder.is_file() and folder.suffix.lower() in {".jpg", ".jpeg", ".png"} and (
                "b_and_r" in str(folder) or "bole" in str(folder)):
            photos.add(folder)
    groups = {}
    for image in sorted(photos):
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        groups.setdefault(digest, []).append(str(image.relative_to(ROOT)))
    truths = []
    for p in sorted((ROOT / "datasets").rglob("b_and_r*/*.truth.yml")):
        truth = yaml.safe_load(p.read_text())
        truths.append(dict(path=str(p.relative_to(ROOT)), controller=truth["controller_family"],
                           fields=sorted(truth["fields"]), provenance=truth["provenance"]))
    packages = []
    for p in sorted((ROOT / "templates").rglob("*.json")):
        document = json.loads(p.read_text())
        if document.get("package_schema") and document.get("profile_id", "").startswith("b_and_r."):
            packages.append(dict(path=str(p.relative_to(ROOT)), sha256=hashlib.sha256(p.read_bytes()).hexdigest(),
                                 profile_id=document["profile_id"], version=document["version"],
                                 schema=document["package_schema"]))
    write_evidence("r6-bole-inventory.json", dict(photos_by_sha256=groups, photo_paths=len(photos),
        unique_photos=len(groups), old_truths=truths, packages=packages,
        scope=dict(controller="B_AND_R", raw_page=PROFILE, new_physical_layouts=0,
                   note="Existing injection/holding layout gains a v2 raw contract; other layouts only regress.")))
    assert len(groups) >= 15
    assert any(row["controller"] == "KEBA" for row in truths), "Do not infer controller from the directory name"
    definition = bole_injection_package()["raw_field_definition"]
    assert {s["purpose"] for s in definition["samples"]} == {"development", "reserved_regression"}
    assert len({s["image_sha256"] for s in definition["samples"]}) == 2
    assert definition["page_identity"]["interface_generation"] is None


def test_a04_a11_actual_ocr_matches_original_values_and_preserves_unknown(live):
    _, samples = live
    for name, sample in samples.items():
        observation = sample["observation"]
        truth = json.loads((ROOT / sample["spec"]["truth"]).read_text())["values"]
        assert len(observation["fields"]) == len(truth) == 47
        assert observation["coverage"]["status"] == "partial"
        observed = {f["screen_field_key"]: f for f in observation["fields"]}
        for key, field in observed.items():
            assert field["state"] == "unknown"
            assert field["role"] != "monitoring"
            if field["original_value"] is not None:
                assert field["original_value"] == truth[key], (name, key, field)
                assert field["bbox"] and field["original_bbox"]
            elif truth[key] is not None:
                assert field["reading"] in {"missing", "uncertain", "conflict"}
            if field["reading"] == "known":
                assert field["original_value"] == truth[key]
        assert observed["injection.speed.stage-1"]["original_value"] == (40 if name == "development" else 60)
        assert observed["injection.time.stage-1"]["original_value"] == (.57 if name == "development" else .95)
        assert observed["injection.time.stage-1"]["role"] == "actual"
        residual = observed["injection.speed.stage-4" if name == "development" else "injection.speed.stage-2"]
        assert residual["original_value"] == 0 and residual["state"] == "unknown"
        assert observed["holding.time.stage-1"]["original_value"] == (1 if name == "development" else 5)
        assert observed["holding.time.stage-1"]["role"] == "setting"
        assert observed["switch.setting.time"]["original_value"] == 5
        assert observed["switch.time.selected"]["reading"] == "unsupported"


def test_a04_a11_low_confidence_missing_duplicates_and_physical_order(live):
    sample = live[1]["development"]
    lines = copy.deepcopy(sample["ocr"]["lines"])
    cell = next(c for c in lines if c["text"] == "75.0")
    cell["conf"] = .2
    observed = observe_bole_injection(lines, sample["meta"], sample["spec"]["image_sha256"])
    field = next(f for f in observed["fields"] if f["screen_field_key"] == "injection.speed.stage-2")
    assert field["original_value"] == 75 and field["reading"] == "uncertain" and field["state"] == "unknown"
    lines.remove(cell)
    observed = observe_bole_injection(lines, sample["meta"], sample["spec"]["image_sha256"])
    field = next(f for f in observed["fields"] if f["screen_field_key"] == "injection.speed.stage-2")
    assert field["original_value"] is None and field["reading"] == "missing"
    lines = copy.deepcopy(sample["ocr"]["lines"])
    header = next(c for c in lines if c["text"] == "3")
    lines.append(copy.deepcopy(header))
    observed = observe_bole_injection(lines, sample["meta"], sample["spec"]["image_sha256"])
    assert any(i["code"] == "STAGE_IDENTITY_CONFLICT" for i in observed["issues"])
    assert all(f["reading"] == "conflict" for f in observed["fields"] if f.get("stage") and f["section"] == "injection")
    lines = copy.deepcopy(sample["ocr"]["lines"])
    head = next(c for c in lines if c["text"] == "3")
    head2 = next(c for c in lines if c["text"] == "2" and c["bbox"]["y_min"] < 700)
    head["text"], head2["text"] = "2", "3"
    observed = observe_bole_injection(lines, sample["meta"], sample["spec"]["image_sha256"])
    by_key = {f["screen_field_key"]: f for f in observed["fields"]}
    assert by_key["injection.speed.stage-2"]["original_value"] == 20
    assert by_key["injection.speed.stage-3"]["original_value"] == 75
    assert by_key["injection.speed.stage-2"]["order"] == 3
    assert by_key["injection.speed.stage-3"]["order"] == 4
    lines = copy.deepcopy(sample["ocr"]["lines"])
    cell = next(c for c in lines if c["text"] == "75.0")
    cell["text"] = "75.0mm"
    observed = observe_bole_injection(lines, sample["meta"], sample["spec"]["image_sha256"])
    field = next(f for f in observed["fields"] if f["screen_field_key"] == "injection.speed.stage-2")
    assert field["original_value"] == 75 and field["original_unit"] == "mm" and field["reading"] == "conflict"


@pytest.fixture
def storage(monkeypatch):
    root = Path(tempfile.mkdtemp(prefix="r6-storage-", dir=OUTPUT))
    for folder in ("templates", "contracts", "tests/fixtures"):
        shutil.copytree(ROOT / folder, root / folder)
    monkeypatch.setattr(admin, "ROOT", root)
    app = FastAPI()
    app.include_router(admin.router)
    return root, app


def test_a18_package_http_get_fresh_client_and_offline_reopen(storage, live):
    root, app = storage
    package = bole_injection_package(root)
    for _ in range(2):
        with TestClient(app) as reopened:
            response = reopened.get(f"{PREFIX}/{PROFILE}/package", params={"version": VERSION})
        assert response.status_code == 200, response.text
        assert import_raw_package(response.json()) == package
    imported = import_raw_package(json.loads(json.dumps(package)))
    exported = subprocess.run([sys.executable, "scripts/export_page_package.py", PROFILE, VERSION],
                              cwd=ROOT, text=True, capture_output=True, timeout=30)
    assert exported.returncode == 0, exported.stdout + exported.stderr
    assert import_raw_package(json.loads(exported.stdout)) == imported
    validate_raw_record(json.loads(json.dumps(live[1]["development"]["observation"])), imported)
    for version in ("0.1.0", "0.1.1", "0.1.2"):
        with TestClient(app) as reopened:
            old = reopened.get(f"{PREFIX}/{PROFILE}/package", params={"version": version})
        assert old.status_code == 200, old.text
        assert old.json()["package_schema"] == "hmi_page_package.v1"
        write_evidence(f"old-injection-{version}.json", old.json())
    write_evidence("r6-bole-exported-package.json", package)


def test_existing_controlled_draft_trial_uses_actual_ocr_and_reopens(storage, monkeypatch):
    root, app = storage
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "r6-isolated")
    package = bole_injection_package(root)
    body = dict(expected_version="0.1.2", template=package["template"], samples=package["samples"])
    headers = {"Authorization": "Bearer r6-isolated"}
    with TestClient(app) as client:
        denied = client.put(f"{PREFIX}/drafts/{PROFILE}", json=body)
        assert denied.status_code == 401
        assert not (root / "templates/drafts" / f"{PROFILE}.json").exists()
        saved = client.put(f"{PREFIX}/drafts/{PROFILE}", json=body, headers=headers)
        assert saved.status_code == 200, saved.text
        trial = client.post(f"{PREFIX}/drafts/{PROFILE}/trial", json={"expected_revision": 1}, headers=headers)
        assert trial.status_code == 200, trial.text
        assert len(trial.json()["after"]) == 2
        assert all(row["result"]["detail"]["page_observations"]["fields"] for row in trial.json()["after"])
    with TestClient(app) as reopened:
        read = reopened.get(f"{PREFIX}/drafts/{PROFILE}", headers=headers)
        assert read.status_code == 200 and read.json() == saved.json()
    write_evidence("r6-bole-controlled-trial.json", trial.json())


def test_frozen_sources_cannot_be_replaced_and_old_package_bytes_are_retained(storage):
    root, _ = storage
    path = root / "templates/raw-packages" / PROFILE / f"{VERSION}.json"
    package = bole_injection_package(root)
    damaged = copy.deepcopy(package)
    damaged["recognizer"]["sources"]["scripts/raw_bole_injection.py"] += "\n"
    path.write_text(json.dumps(damaged))
    with pytest.raises(ValueError, match="RAW_RECOGNIZER_HASH_MISMATCH"):
        bole_injection_package(root)
    damaged = copy.deepcopy(package)
    damaged["raw_field_definition"]["fields"][0]["unit"] = "mm"
    damaged["raw_field_definition_sha256"] = canonical_hash(damaged["raw_field_definition"])
    path.write_text(json.dumps(damaged))
    with pytest.raises(ValueError, match="RAW_DEFINITION_MISMATCH"):
        bole_injection_package(root)
    paths = ["templates/packages/b_and_r.metering.three_stage/1.0.0.json",
             "templates/packages/b_and_r.metering.three_stage/1.0.1.json",
             "templates/raw-packages/demag.injection_metering.multi_stage_holding/0.3.0.json",
             "templates/raw-packages/demag.temperature.screen_order_5/0.4.1.json",
             "scripts/raw_metering.py", "scripts/raw_temperature_time.py"]
    checks = {}
    for name in paths:
        original = subprocess.check_output(["git", "show", f"f12e3ac3808f60027530d70c4ff6303ce295174b:{name}"], cwd=ROOT)
        assert (ROOT / name).read_bytes() == original
        checks[name] = hashlib.sha256(original).hexdigest()
    write_evidence("r6-bole-immutable-baseline.json", checks)


def test_a07_pinned_binding_rejects_wrong_unknown_disabled_conflict_and_contract(storage, live):
    from scripts.extract_fields import extract_one

    root, app = storage
    package = bole_injection_package(root)
    hint = dict(brand="BOLE", controller_family="B_AND_R", interface_generation=None, binding_revision=1,
                pages=[dict(profile_id=PROFILE, version=VERSION, package_sha256=canonical_hash(package))])
    directory = live[0]
    result = extract_one("development", directory, {}, {}, root / "templates", controller_hint=hint)
    assert result["compatibility"]["code"] == "PAGE_COMPATIBLE", result
    results = {}
    for name, changes, expected in [
        ("wrong", dict(controller_family="EST"), "PAGE_BINDING_MISMATCH"),
        ("hash", dict(pages=[{**hint["pages"][0], "package_sha256": "0" * 64}]), "PAGE_PACKAGE_INCOMPATIBLE"),
        ("version", dict(pages=[{**hint["pages"][0], "version": "99.0.0"}]), "PAGE_PACKAGE_INCOMPATIBLE"),
    ]:
        rejected = extract_one("development", directory, {}, {}, root / "templates", controller_hint={**hint, **changes})
        assert rejected["compatibility"]["code"] == expected
        assert not rejected.get("fields") and not any("GENERIC_FALLBACK" in w for w in rejected["warnings"])
        results[name] = rejected["compatibility"]
    unknown = root / "unknown"
    unknown.mkdir()
    (unknown / "development.rectify.json").write_bytes((directory / "development.rectify.json").read_bytes())
    (unknown / "development.ocr.json").write_text(json.dumps(dict(lines=[dict(text="unknown panel", conf=.99,
        bbox=dict(x_min=1, y_min=1, x_max=20, y_max=20))])))
    rejected = extract_one("development", unknown, {}, {}, root / "templates", controller_hint=hint)
    assert rejected["compatibility"]["code"] == "PAGE_UNKNOWN" and not rejected.get("fields")
    results["unknown"] = rejected["compatibility"]
    registry_path = root / "contracts/profiles.json"
    before = registry_path.read_bytes()
    registry = json.loads(before)
    other = {**package["template"], "profile_id": "b_and_r.injection_holding.ambiguous"}
    (root / "templates/ambiguous.json").write_text(json.dumps(other))
    registry["profiles"].append(dict(profile_id=other["profile_id"], template="ambiguous.json"))
    registry_path.write_text(json.dumps(registry))
    rejected = extract_one("development", directory, {}, {}, root / "templates", controller_hint=hint)
    assert rejected["compatibility"]["code"] == "PAGE_TEMPLATE_CONFLICT" and not rejected.get("fields")
    results["conflict"] = rejected["compatibility"]
    registry_path.write_bytes(before)
    active = root / "templates/b_and_r/injection_holding.json"
    template = json.loads(active.read_text())
    template["enabled"] = False
    active.write_text(json.dumps(template))
    rejected = extract_one("development", directory, {}, {}, root / "templates", controller_hint=hint)
    assert rejected["compatibility"]["code"] == "PAGE_TEMPLATE_DISABLED" and not rejected.get("fields")
    results["disabled"] = rejected["compatibility"]
    template["enabled"] = True
    active.write_text(json.dumps(template))
    damaged = copy.deepcopy(package)
    damaged["template"]["contract_version"] = "unsupported-contract"
    raw_path = root / "templates/raw-packages" / PROFILE / f"{VERSION}.json"
    raw_path.write_text(json.dumps(damaged))
    changed = {**hint, "pages": [{**hint["pages"][0], "package_sha256": canonical_hash(damaged)}]}
    rejected = extract_one("development", directory, {}, {}, root / "templates", controller_hint=changed)
    assert rejected["compatibility"]["code"] == "EXTRACTOR_CONTRACT_INCOMPATIBLE" and not rejected.get("fields")
    results["contract"] = rejected["compatibility"]
    write_evidence("r6-bole-compatibility.json", results)


def test_a04_a18_manual_disabled_residual_is_preserved_without_fabricated_image(live):
    package = bole_injection_package()
    source = next(f for f in live[1]["development"]["observation"]["fields"]
                  if f["screen_field_key"] == "injection.speed.stage-4")
    field = {k: source[k] for k in ("screen_field_key", "original_label", "original_value", "original_unit", "role")}
    field.update(source="manual", state="disabled", reading="known", original_bbox=None)
    record = dict(schema_version="page_observations.v2", profile_id=PROFILE, source="manual", actor="r6-reviewer",
                  created_at="2026-10-20T14:00:00Z", revision=1,
                  raw_field_definition_sha256=package["raw_field_definition_sha256"], fields=[field])
    assert validate_raw_record(record, package)["fields"][0]["original_value"] == 0
    assert record["fields"][0]["state"] == "disabled" and "image_sha256" not in record
    assert all(f["state"] == "unknown" for f in live[1]["development"]["observation"]["fields"])
    write_evidence("r6-bole-manual-disabled-contract.json", record)


def test_real_http_original_upload_and_cli_readback(storage, live, engine, monkeypatch):
    import hmi_service as service

    root, app = storage
    monkeypatch.setattr(service, "HERE", root)
    monkeypatch.setattr(service, "ocr_model", engine)
    monkeypatch.setattr(service, "is_ready", True)
    monkeypatch.setattr(service, "concurrency_semaphore", asyncio.Semaphore(1))
    monkeypatch.delenv("HMI_API_KEY", raising=False)
    for name, sample in live[1].items():
        content = (ROOT / sample["spec"]["image"]).read_bytes()

        async def upload(params):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://reader") as client:
                return await client.post("/api/v1/recognize", params=params,
                                         files={"file": (f"{name}.jpg", content, "image/jpeg")})

        response = asyncio.run(upload({"observations_version": "v2"}))
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["profile_id"] == PROFILE, result
        record = result["page_observations"]
        validate_raw_record(record, bole_injection_package(root))
        assert record["image_sha256"] == hashlib.sha256(content).hexdigest()
        truth = json.loads((ROOT / sample["spec"]["truth"]).read_text())["values"]
        for field in record["fields"]:
            if field["original_value"] is not None:
                assert field["original_value"] == truth[field["screen_field_key"]], field
        by_key = {f["screen_field_key"]: f for f in record["fields"]}
        assert by_key["injection.speed.stage-1"]["original_value"] == (40 if name == "development" else 60)
        assert by_key["switch.setting.time"]["original_value"] == 5
        write_evidence(f"r6-bole-http-{name}.json", result)
        package = bole_injection_package(root)
        hint = dict(brand="BOLE", controller_family="B_AND_R", interface_generation=None, binding_revision=1,
                    pages=[dict(profile_id=PROFILE, version=VERSION, package_sha256=canonical_hash(package))])
        bound = asyncio.run(upload(dict(observations_version="v2", controller_hint=json.dumps(hint))))
        assert bound.status_code == 200, bound.text
        assert bound.json()["compatibility"]["code"] == "PAGE_COMPATIBLE"
        validate_raw_record(bound.json()["page_observations"], package)
        write_evidence(f"r6-bole-bound-http-{name}.json", bound.json())
        command = [sys.executable, "scripts/extract_fields.py", name, "--rectified-dir", str(live[0]),
                   "--output-dir", str(root / "cli"), "--templates-dir", str(root / "templates"),
                   "--record-report", str(root / "absent"), "--labels", str(root / "absent"),
                   "--observations-version", "v2", "--original-image", str(ROOT / sample["spec"]["image"])]
        process = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=60)
        assert process.returncode == 0, process.stdout + process.stderr
        decoded = json.loads((root / "cli" / f"{name}.fields.json").read_text())
        validate_raw_record(decoded["page_observations"], bole_injection_package(root))
        assert decoded["page_observations"]["image_sha256"] == record["image_sha256"]
        assert decoded["page_observations"]["fields"] == sample["observation"]["fields"]
        write_evidence(f"r6-bole-cli-{name}.json", decoded)


def test_a18_existing_metering_package_and_temperature_regress_on_real_photos(engine):
    from scripts.rectify import rectify
    from scripts.ocr_variants import run_ocr
    from scripts.extract_fields import extract_one
    from scripts.raw_metering import metering_package, observe_metering_page
    from scripts.raw_page_ocr import engine_identity

    directory = Path(tempfile.mkdtemp(prefix="r6-existing-", dir=OUTPUT))
    package = metering_package(version="1.0.1")
    metering = package["raw_field_definition"]["samples"][0]
    temp = "datasets/calibration/b_and_r.temperature.fixed/barrel_B01_f056d349.jpeg"
    coverage = []
    for name, image in [("metering", ROOT / metering["image"]), ("temperature", ROOT / temp)]:
        meta = rectify(image, directory / f"{name}.png", directory / f"{name}.rectify.json")
        assert meta["ok"]
        lines = run_ocr(engine, directory / f"{name}.png")
        (directory / f"{name}.ocr.json").write_text(json.dumps(dict(lines=lines, engine_identity=engine_identity(engine))))
        result = extract_one(name, directory, {}, {}, ROOT / "templates")
        assert result["controller_family"] == "B_AND_R", result
        if name == "metering":
            observed = observe_metering_page(lines, meta, meta["original_sha256"], version="1.0.1")
            observed["engine"] = engine_identity(engine)
            validate_raw_record(observed, package)
            truth = json.loads((ROOT / metering["truth"]).read_text())["values"]
            assert len(observed["fields"]) == 38
            for field in observed["fields"]:
                if field["reading"] == "known":
                    assert field["original_value"] == truth[field["screen_field_key"]]
            assert any(f["original_value"] == 110 for f in observed["fields"])
            write_evidence("r6-bole-metering-v2.json", observed)
        else:
            assert result["page_type"] == "temperature"
            assert result["fields"]["barrel_temperature_set_c"] == [285, 270, 266, 265, 260, 250], result
        coverage.append(dict(page=name, image=str(image.relative_to(ROOT)), image_sha256=meta["original_sha256"],
                             status=result["status"], warnings=result["warnings"], fields=result["fields"]))
    write_evidence("r6-bole-existing-regression.json", coverage)


def test_a07_cropped_original_returns_explicit_http_and_cli_rejection(engine, monkeypatch):
    import hmi_service as service
    from scripts.rectify import rectify
    from scripts.ocr_variants import run_ocr
    from scripts.raw_page_ocr import engine_identity

    image = ROOT / "datasets/r6_bole/cropped-layout.jpg"
    digest = hashlib.sha256(image.read_bytes()).hexdigest()
    assert digest == "a9b6de684ae93c312a1c8cb7b8eb22eeee1ce6bcf2d903cd05ab0318b3e5cf1c"
    monkeypatch.setattr(service, "ocr_model", engine)
    monkeypatch.setattr(service, "is_ready", True)
    monkeypatch.setattr(service, "concurrency_semaphore", asyncio.Semaphore(1))
    monkeypatch.delenv("HMI_API_KEY", raising=False)
    package = bole_injection_package()
    hint = dict(brand="BOLE", controller_family="B_AND_R", interface_generation=None, binding_revision=1,
                pages=[dict(profile_id=PROFILE, version=VERSION, package_sha256=canonical_hash(package))])

    async def upload(params):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app, raise_app_exceptions=False),
                                     base_url="http://reader") as client:
            return await client.post("/api/v1/recognize", params=params,
                                     files={"file": ("cropped.jpg", image.read_bytes(), "image/jpeg")})

    for label, params in [("plain", dict(observations_version="v2")),
                          ("bound", dict(observations_version="v2", controller_hint=json.dumps(hint)))]:
        response = asyncio.run(upload(params))
        write_evidence(f"cropped-http-{label}.json", dict(status_code=response.status_code, body=response.json()))
        assert response.status_code == 422, response.text
        assert response.json()["detail"]["code"] == "BOLE_INJECTION_LAYOUT_UNVERIFIED"
        assert response.json()["detail"]["action"] == "review_or_recapture_full_screen"
        assert not response.json().get("fields") and not response.json().get("page_observations")

    directory = Path(tempfile.mkdtemp(prefix="cropped-cli-", dir=OUTPUT))
    meta = rectify(image, directory / "cropped.png", directory / "cropped.rectify.json")
    assert meta["ok"]
    lines = run_ocr(engine, directory / "cropped.png")
    (directory / "cropped.ocr.json").write_text(json.dumps(dict(lines=lines, engine_identity=engine_identity(engine))))
    for label, extra in [("plain", []), ("bound", ["--controller-hint", str(directory / "hint.json")])]:
        (directory / "hint.json").write_text(json.dumps(hint))
        command = [sys.executable, "scripts/extract_fields.py", "cropped", "--rectified-dir", str(directory),
                   "--output-dir", str(directory / label), "--observations-version", "v2", "--original-image", str(image),
                   "--record-report", str(directory / "absent"), "--labels", str(directory / "absent")] + extra
        process = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=60)
        assert process.returncode == 0, process.stdout + process.stderr
        result = json.loads((directory / label / "cropped.fields.json").read_text())
        assert result["status"] == "reject" and not result.get("fields") and not result.get("page_observations")
        assert result["raw_rejection"]["code"] == "BOLE_INJECTION_LAYOUT_UNVERIFIED"
        assert result["raw_rejection"]["action"] == "review_or_recapture_full_screen"
        assert result["raw_ocr_evidence"]["lines"]
        assert not any("GENERIC_FALLBACK" in w for w in result["warnings"])
        write_evidence(f"cropped-cli-{label}.json", result)


def test_layout_rejection_does_not_hide_invalid_hash_or_corrupt_package(storage):
    from raw_observations import RawPageRejected, observe_temperature_time_page

    root, _ = storage
    with pytest.raises(ValueError, match="IMAGE_HASH_INVALID") as invalid:
        observe_temperature_time_page(PROFILE, [], dict(screen_size=[1, 1]), "invalid", package_root=root)
    assert not isinstance(invalid.value, RawPageRejected)
    path = root / "templates/raw-packages" / PROFILE / f"{VERSION}.json"
    package = json.loads(path.read_text())
    package["recognizer"]["files"]["scripts/raw_bole_injection.py"] = "0" * 64
    path.write_text(json.dumps(package))
    with pytest.raises(ValueError, match="RAW_RECOGNIZER_HASH_MISMATCH") as corrupt:
        observe_temperature_time_page(PROFILE, [], dict(screen_size=[1, 1]), "0" * 64, package_root=root)
    assert not isinstance(corrupt.value, RawPageRejected)
