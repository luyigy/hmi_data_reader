"""YIZUMI frozen raw-page behavior, real CPU OCR and explicit legacy boundaries."""

import asyncio
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import page_template_admin as admin
from controller_binding import content_hash
from export_page_package import export_page_package
from extract_fields import extract_one
from raw_yizumi import observe_yizumi_page, yizumi_package
from raw_contract import canonical_hash, import_raw_package, validate_raw_record

OUTPUT = Path(os.environ.get("AP_GRAPH_OUTPUT_DIR", ROOT / "output/r6_yizumi"))

P11 = "yizumi.injection_metering.injection_holding_f2"
P12 = "yizumi.injection_metering.metering_f2"
SAMPLES = [(P11, "P11_31_20260930"), (P11, "P11_31_20260929"),
           (P12, "P12_31_20260930")]


def replay_sample(directory, profile, sample_id, mutate=None, hint=None, templates=None):
    manifest = json.loads((ROOT / "templates/samples" / profile / f"{sample_id}.json").read_text())
    fixture = ROOT / manifest["ocr_fixture"]
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == manifest["ocr_sha256"]
    ocr = json.loads(fixture.read_text())
    if mutate:
        mutate(ocr["lines"])
    (directory / "sample.ocr.json").write_text(json.dumps(ocr))
    meta = {key: manifest[key] for key in ("screen_size", "original_size", "screen_quad")}
    meta.update(ok=True, method=manifest["rectify_method"])
    (directory / "sample.rectify.json").write_text(json.dumps(meta))
    return extract_one("sample", directory, None, None, templates or ROOT / "templates",
                       controller_hint=hint)


@pytest.mark.parametrize("profile,sample_id", SAMPLES)
def test_a04_a18_known_and_missing_readings_retain_unknown_state(tmp_path, profile, sample_id):
    result = replay_sample(tmp_path, profile, sample_id)
    assert result["profile_id"] == profile
    assert result["status"] == "review"
    assert result["fields"] == {}
    fields = result["extraction_detail"]["page_observations"]["fields"]
    assert fields
    assert all(field["state"] == "unknown" and field["state_basis"] is None for field in fields)
    known = [field for field in fields if field["value"] is not None]
    missing = [field for field in fields if field["value"] is None]
    assert known and missing
    assert all(field["bbox"] and field["original_bbox"] for field in known)
    assert all(field["bbox"] is None for field in missing)
    by_label = {field["label"]: field for field in fields}
    if profile == P12:
        assert by_label["熔胶速度2"]["value"] == 75.0
        assert by_label["熔胶速度2"]["unit"] == "%"
        assert by_label["熔胶背压1"]["value"] is None
        assert all(field["role"] == "unknown" for field in fields)
    else:
        assert by_label["射胶压力1"]["value"] == (100.0 if sample_id.endswith("0930") else 140.0)
        assert by_label["射胶压力1"]["unit"] == "bar"
        assert by_label["射胶压力1"]["role"] == "unknown"
        assert by_label["保压速度1"]["role"] == "setting"


def test_a04_low_confidence_does_not_become_disabled_or_zero(tmp_path):
    original = replay_sample(tmp_path, P11, SAMPLES[0][1])
    baseline = next(field for field in original["extraction_detail"]["page_observations"]["fields"]
                    if field["label"] == "射胶压力1")

    def lower_confidence(lines):
        selected = lines[baseline["line_indexes"][-1]]
        assert selected["text"] == baseline["text"]
        selected["conf"] = .2

    result = replay_sample(tmp_path, P11, SAMPLES[0][1], mutate=lower_confidence)
    field = next(field for field in result["extraction_detail"]["page_observations"]["fields"]
                 if field["label"] == "射胶压力1")
    assert baseline["value"] == 100.0
    assert field["value"] is None
    assert field["state"] == "unknown"
    assert field["role"] == "unknown"
    assert "value_missing_or_ambiguous" in field["reasons"]


def test_a11_printed_stage_identity_survives_reverse_order(tmp_path):
    result = replay_sample(tmp_path, P11, SAMPLES[0][1])
    fields = result["extraction_detail"]["page_observations"]["fields"]
    pressure = [field for field in fields if field["label"].startswith("射胶压力")]
    assert [(field["stage"], field["value"]) for field in pressure] == [
        (3, 90.0), (2, 95.0), (1, 100.0)]
    assert [field["bbox"][0] for field in pressure] == sorted(field["bbox"][0] for field in pressure)


@pytest.mark.parametrize("profile,sample_id,label,code", [
    (P11, "P11_31_20260930", "一段", "YIZUMI_STAGE_IDENTITY_CONFLICT"),
    (P12, "P12_31_20260930", "熔胶1", "YIZUMI_STAGE_IDENTITY_CONFLICT"),
    (P12, "P12_31_20260930", "速度", "YIZUMI_ROW_IDENTITY_CONFLICT"),
])
def test_a11_duplicate_identity_reports_conflict_without_overwriting(
        tmp_path, profile, sample_id, label, code):
    evidence_indexes = []

    def duplicate_label(lines):
        index = next(index for index, line in enumerate(lines) if line["text"] == label)
        evidence_indexes.extend([index, len(lines)])
        lines.append(dict(lines[index]))

    result = replay_sample(tmp_path, profile, sample_id, mutate=duplicate_label)
    assert code in result["warnings"]
    assert not result.get("fields")
    assert not any("GENERIC_FALLBACK" in warning for warning in result["warnings"])
    observation = result["extraction_detail"]["page_observations"]
    issue = next(issue for issue in observation["issues"] if issue["code"] == code)
    assert issue["line_indexes"] == evidence_indexes
    if profile == P11:
        assert result["status"] == "review"
        assert issue["section"] == "injection"
        assert issue["stage_ids"] == [1]
        assert all(field["section"] == "holding" for field in observation["fields"])
        assert {field["label"]: field["value"] for field in observation["fields"]} == {
            "保压压力1": 80.0, "保压速度1": 5.0, "保压时间1": 4.0}
    else:
        assert result["status"] == "reject"
        assert issue["section"] == "plasticizing"
        assert observation["fields"] == []
        if label == "熔胶1":
            assert issue["stage_ids"] == [1]
        else:
            assert issue["labels"] == ["速度"]


@pytest.mark.parametrize("profile", [P11, P12])
@pytest.mark.parametrize("invalid", ["unverified_controller", "wrong_hash", "unknown_controller"])
def test_a07_binding_cannot_force_legacy_page_success(tmp_path, profile, invalid):
    package = export_page_package(profile, "0.1.0", ROOT)
    hint = dict(brand="YIZUMI", controller_family="YIZUMI", interface_generation=None,
                binding_revision=1, pages=[dict(profile_id=profile, version="0.1.0",
                                                package_sha256=content_hash(package))])
    expected = "CONTROLLER_METADATA_UNVERIFIED"
    if invalid == "wrong_hash":
        hint["pages"][0]["package_sha256"] = "0" * 64
        expected = "PAGE_PACKAGE_INCOMPATIBLE"
    elif invalid == "unknown_controller":
        hint["pages"][0]["profile_id"] = "yizumi.unregistered.layout"
        expected = "CONTROLLER_UNKNOWN"
    sample_id = next(sample for candidate, sample in SAMPLES if candidate == profile)
    result = replay_sample(tmp_path, profile, sample_id, hint=hint)
    assert result["status"] == "reject"
    assert result["compatibility"]["code"] == expected
    assert not result.get("fields")
    assert not any("GENERIC_FALLBACK" in warning for warning in result["warnings"])


def test_a07_disabled_page_does_not_fall_back(tmp_path):
    templates = tmp_path / "templates"
    (templates / "yizumi").mkdir(parents=True)
    (tmp_path / "contracts").mkdir()
    candidate = json.loads((ROOT / "templates/yizumi/injection_holding.json").read_text())
    candidate["enabled"] = False
    (templates / "yizumi/injection_holding.json").write_text(json.dumps(candidate))
    (templates / "b_and_r.injection_metering.json").write_bytes(
        (ROOT / "templates/b_and_r.injection_metering.json").read_bytes())
    (tmp_path / "contracts/profiles.json").write_text(json.dumps({"profiles": [
        {"profile_id": P11, "template": "yizumi/injection_holding.json"}]}))
    result = replay_sample(tmp_path, P11, SAMPLES[0][1], templates=templates)
    assert result["status"] == "reject"
    assert result["warnings"] == ["PAGE_TEMPLATE_DISABLED"]
    assert not result.get("fields")


@pytest.mark.parametrize("profile,expected_count", [(P11, 2), (P12, 1)])
def test_a17_a18_package_get_reopens_without_recognition(monkeypatch, profile, expected_count):
    monkeypatch.setattr(admin, "ROOT", ROOT)

    def reject_recognition(*args, **kwargs):
        pytest.fail("Package GET/reopen invoked recognition")

    monkeypatch.setattr("extract_fields.extract_one", reject_recognition)
    app = FastAPI()
    app.include_router(admin.router)
    url = f"/api/v1/page-templates/{profile}/package?version=0.1.0"
    with TestClient(app) as first:
        response = first.get(url)
        assert response.status_code == 200, response.text
        package = response.json()
    with TestClient(app) as reopened:
        response = reopened.get(url)
        assert response.status_code == 200, response.text
        assert response.json() == package
    assert package == export_page_package(profile, "0.1.0", ROOT)
    assert len(package["samples"]) == expected_count
    original_hashes = set()
    for sample in package["samples"]:
        manifest = sample["manifest"]
        assert manifest["purpose"] == "development_exposed_not_independent_test"
        assert sample["ocr"] == json.loads((ROOT / manifest["ocr_fixture"]).read_text())
        original_hashes.add(manifest["original_sha256"])
    assert len(original_hashes) == expected_count


def record_evidence(name, document):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / f"{name}.json").write_text(json.dumps(document, ensure_ascii=False, indent=2))


@pytest.fixture(scope="module")
def real_images():
    from paddleocr import PaddleOCR
    from rectify import rectify
    from raw_page_ocr import engine_identity

    directory = OUTPUT / "verified-live"
    directory.mkdir(parents=True, exist_ok=True)
    models = OUTPUT / "models"
    engine = PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False,
                       det_model_dir=str(models / "det"), rec_model_dir=str(models / "rec"),
                       cls_model_dir=str(models / "cls"))
    observations = {}
    package = yizumi_package()
    for name in ("development", "retained"):
        path = ROOT / f"datasets/r6_yizumi/{name}.jpg"
        truth = json.loads((ROOT / f"datasets/r6_yizumi/{name}.truth.json").read_text())
        assert hashlib.sha256(path.read_bytes()).hexdigest() == truth["image_sha256"]
        meta = rectify(path, directory / f"{name}.png", directory / f"{name}.rectify.json")
        assert meta["ok"], meta
        raw = engine.ocr(str(directory / f"{name}.png"), cls=False)
        lines = []
        for points, (text, confidence) in raw[0] or []:
            xs, ys = zip(*points)
            lines.append(dict(text=text, conf=float(confidence), bbox=dict(
                x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
        assert lines
        ocr = dict(lines=lines, engine_identity=engine_identity(engine))
        (directory / f"{name}.ocr.json").write_text(json.dumps(ocr, ensure_ascii=False))
        result = observe_yizumi_page(lines, meta, truth["image_sha256"])
        result["engine"] = ocr["engine_identity"]
        validate_raw_record(result, package)
        observations[name] = result
        record_evidence(f"live-{name}", result)
    return engine, directory, observations


@pytest.mark.parametrize("name", ["development", "retained"])
def test_a04_a17_real_originals_known_readings_match_visible_truth(real_images, name):
    result = real_images[2][name]
    truth = json.loads((ROOT / f"datasets/r6_yizumi/{name}.truth.json").read_text())
    assert result["coverage"]["status"] == "partial"
    assert len(result["fields"]) == 40
    known = [field for field in result["fields"] if field["reading"] == "known"]
    assert len(known) >= (25 if name == "development" else 15)
    for field in known:
        assert field["original_value"] == pytest.approx(truth["values"][field["screen_field_key"]])
        assert field["bbox"] and field["original_bbox"]
    fields = {field["screen_field_key"]: field for field in result["fields"]}
    assert fields["left.cooling.setting"]["original_value"] == (15 if name == "development" else 10)
    assert fields["left.injection.max_speed"]["role"] == "actual"
    assert fields["left.injection.max_speed"]["original_value"] == (79.3 if name == "development" else 93.1)
    assert fields["vp.time.left"]["original_value"] == 1.5
    assert fields["vp.time.left"]["state"] == "unknown"
    assert fields["vp.position.selected"]["reading"] == "unsupported"
    assert all(field["state"] == "unknown" for field in result["fields"])
    assert result["image_sha256"] == result["transform"]["original_sha256"] == truth["image_sha256"]
    assert result["package_sha256"] == canonical_hash(yizumi_package())


def test_a04_raw_low_confidence_retains_value_and_manual_states_are_independent(real_images):
    original = real_images[2]["development"]
    lines = copy.deepcopy(original["ocr_evidence"]["lines"])
    field = next(field for field in original["fields"] if field["screen_field_key"] == "left.injection.max_speed")
    lines[field["line_indexes"][0]]["conf"] = .2
    result = observe_yizumi_page(lines, original["transform"], original["image_sha256"])
    uncertain = next(field for field in result["fields"] if field["screen_field_key"] == "left.injection.max_speed")
    assert (uncertain["original_value"], uncertain["role"], uncertain["state"], uncertain["reading"]) == (
        79.3, "actual", "unknown", "uncertain")
    assert uncertain["original_bbox"] == field["original_bbox"]
    for state in ("enabled", "disabled", "unknown"):
        manual = dict(schema_version="page_observations.v2", source="manual", profile_id=P11,
                      raw_field_definition_sha256=original["raw_field_definition_sha256"],
                      actor="r6-behavior-fixture", revision=1, created_at="2026-10-21T00:00:00Z", fields=[dict(
                          screen_field_key="vp.time.left", source="manual", original_label="时间模式",
                          original_value=1.5, original_unit="s", original_bbox=None,
                          role="setting", state=state, reading="known")])
        assert validate_raw_record(manual, yizumi_package())["fields"][0]["original_value"] == 1.5
    assert all(field["state"] == "unknown" for field in original["fields"])


def test_a11_raw_stage_identity_tracks_headers_and_duplicate_is_explicit(real_images):
    original = real_images[2]["development"]
    lines = copy.deepcopy(original["ocr_evidence"]["lines"])
    first = next(index for index, line in enumerate(lines) if line["text"] == "一段")
    third = next(index for index, line in enumerate(lines) if line["text"] == "三段")
    lines[first]["text"], lines[third]["text"] = lines[third]["text"], lines[first]["text"]
    result = observe_yizumi_page(lines, original["transform"], original["image_sha256"])
    fields = {field["screen_field_key"]: field for field in result["fields"]}
    assert (fields["injection.pressure.stage-1"]["original_value"], fields["injection.pressure.stage-1"]["order"]) == (120, 1)
    assert (fields["injection.pressure.stage-3"]["original_value"], fields["injection.pressure.stage-3"]["order"]) == (140, 3)
    lines.append(copy.deepcopy(lines[third]))
    conflict = observe_yizumi_page(lines, original["transform"], original["image_sha256"])
    assert any(issue["code"] == "STAGE_IDENTITY_CONFLICT" for issue in conflict["issues"])
    affected = next(field for field in conflict["fields"] if field["screen_field_key"] == "injection.pressure.stage-1")
    assert affected["reading"] == "conflict" and affected["original_value"] is None


@pytest.fixture
def published(tmp_path, monkeypatch):
    (tmp_path / "contracts").mkdir()
    (tmp_path / "templates/yizumi").mkdir(parents=True)
    profiles = json.loads((ROOT / "contracts/profiles.json").read_text())["profiles"]
    (tmp_path / "contracts/profiles.json").write_text(json.dumps({"profiles": [
        profile for profile in profiles if profile["profile_id"] in (P11, P12)]}))
    for name in ("injection_holding", "metering_f2"):
        shutil.copyfile(ROOT / f"templates/yizumi/{name}.json", tmp_path / f"templates/yizumi/{name}.json")
    shutil.copytree(ROOT / "templates/samples", tmp_path / "templates/samples")
    shutil.copytree(ROOT / "tests/fixtures", tmp_path / "tests/fixtures")
    monkeypatch.setattr(admin, "ROOT", tmp_path)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "r6-isolated")
    app = FastAPI()
    app.include_router(admin.router)
    client = TestClient(app)
    package = yizumi_package()
    body = dict(expected_version="0.1.0", template=package["template"], samples=package["samples"])
    headers = {"Authorization": "Bearer r6-isolated"}
    url = f"/api/v1/page-templates/drafts/{P11}"
    denied = client.put(url, json=body)
    assert denied.status_code in (401, 403)
    response = client.put(url, json=body, headers=headers)
    assert response.status_code == 200, response.text
    response = client.post(url + "/trial", json={"expected_revision": 1}, headers=headers)
    assert response.status_code == 200, response.text
    response = client.post(url + "/publish", json=dict(expected_revision=1, expected_version="0.1.0",
                                                       confirmation="publish_confirmed"), headers=headers)
    assert response.status_code == 200, response.text
    frozen = client.get(f"/api/v1/page-templates/{P11}/package?version={package['version']}")
    assert frozen.status_code == 200, frozen.text
    assert frozen.json() == package
    record_evidence("published-package", frozen.json())
    return tmp_path, client, package


def test_a17_a18_publish_export_offline_definition_and_new_client_reopen(published):
    root, _, package = published
    import_raw_package(package)
    assert len(package["raw_field_definition"]["fields"]) == 40
    assert "web_target" not in json.dumps(package["raw_field_definition"])
    app = FastAPI()
    app.include_router(admin.router)
    with TestClient(app) as reopened:
        assert reopened.get(f"/api/v1/page-templates/{P11}/package?version={package['version']}").json() == package
        old = reopened.get(f"/api/v1/page-templates/{P11}/package?version=0.1.0")
        assert old.status_code == 200
        assert old.json()["package_schema"] == "hmi_page_package.v1"
    assert export_page_package(P11, package["version"], root) == package
    process = subprocess.run([sys.executable, str(ROOT / "scripts/export_page_package.py"), P11, package["version"]],
                             cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert process.returncode == 0, process.stderr
    assert json.loads(process.stdout) == package


@pytest.mark.parametrize("tamper", ["definition", "source", "ocr", "manifest"])
def test_a07_frozen_package_tampering_is_rejected(tmp_path, tamper):
    package = copy.deepcopy(yizumi_package())
    version = package["version"]
    if tamper == "definition":
        package["raw_field_definition"]["fields"][0]["role"] = "setting"
    elif tamper == "source":
        package["recognizer"]["sources"]["scripts/raw_yizumi.py"] += "\n"
    elif tamper == "ocr":
        package["samples"][0]["ocr"]["lines"][0]["text"] = "tampered"
    else:
        package["samples"][0]["manifest"]["original_size"] = [1, 1]
    path = tmp_path / "templates/packages" / P11 / f"{version}.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(package))
    with pytest.raises(ValueError, match="HASH_MISMATCH|OCR_MISMATCH|MANIFEST_MISMATCH"):
        yizumi_package(tmp_path, version=version)


def test_a07_a18_pinned_binding_conflict_disable_and_rollback(published, real_images):
    root, client, package = published
    hint = dict(brand="YIZUMI", controller_family="YIZUMI", interface_generation=None,
                binding_revision=1, pages=[dict(profile_id=P11, version=package["version"], package_sha256=canonical_hash(package))])

    def collect(binding):
        return extract_one("development", real_images[1], None, None, root / "templates", controller_hint=binding)

    wrong = {**hint, "controller_family": "OTHER"}
    result = collect(wrong)
    assert result["compatibility"]["code"] == "PAGE_BINDING_MISMATCH" and not result.get("fields")
    conflict_path = root / "templates/yizumi/conflict.json"
    conflict = {**package["template"], "profile_id": "yizumi.injection_metering.conflicting"}
    conflict_path.write_text(json.dumps(conflict))
    registry_path = root / "contracts/profiles.json"
    registry = json.loads(registry_path.read_text())
    registry["profiles"].append(dict(profile_id=conflict["profile_id"], template="yizumi/conflict.json"))
    registry_path.write_text(json.dumps(registry))
    result = collect(hint)
    assert result["compatibility"]["code"] == "PAGE_TEMPLATE_CONFLICT" and not result.get("fields")
    registry["profiles"].pop()
    registry_path.write_text(json.dumps(registry))
    headers = {"Authorization": "Bearer r6-isolated"}
    url = f"/api/v1/page-templates/drafts/{P11}"
    patch = int(package["version"].split(".")[-1])
    for revision, base, version, enabled in [
            (2, package["version"], f"1.0.{patch + 1}", False),
            (3, f"1.0.{patch + 1}", f"1.0.{patch + 2}", True)]:
        template = {**package["template"], "version": version, "enabled": enabled}
        response = client.put(url, json=dict(expected_version=base, expected_revision=revision - 1,
                                             template=template, samples=package["samples"]), headers=headers)
        assert response.status_code == 200, response.text
        response = client.post(url + "/publish", json=dict(expected_version=base, expected_revision=revision,
                                                           confirmation="publish_confirmed"), headers=headers)
        assert response.status_code == 200, response.text
        result = collect(hint)
        assert result["compatibility"]["code"] == ("PAGE_COMPATIBLE" if enabled else "PAGE_TEMPLATE_DISABLED")
        assert not result.get("fields")
        assert not any("GENERIC_FALLBACK" in warning for warning in result["warnings"])
        assert client.get(f"/api/v1/page-templates/{P11}/package?version={package['version']}").json() == package
    record_evidence("disable-rollback-pinned-binding", result)


def test_live_http_cli_v2_binding_and_a07_wrong_hash(published, real_images, monkeypatch):
    import tempfile
    import hmi_service as service

    root, _, package = published
    monkeypatch.setattr(service, "HERE", root)
    monkeypatch.setattr(service, "ocr_model", real_images[0])
    monkeypatch.setattr(service, "is_ready", True)
    monkeypatch.setattr(service, "concurrency_semaphore", asyncio.Semaphore(1))
    monkeypatch.delenv("HMI_API_KEY", raising=False)
    temporary = OUTPUT / "http-tmp"
    temporary.mkdir(exist_ok=True)
    monkeypatch.setattr(tempfile, "tempdir", str(temporary))
    hint = dict(brand="YIZUMI", controller_family="YIZUMI", interface_generation=None,
                binding_revision=1, pages=[dict(profile_id=P11, version=package["version"], package_sha256=canonical_hash(package))])

    async def upload(binding):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://reader") as client:
            return await client.post("/api/v1/recognize", params=dict(observations_version="v2", controller_hint=json.dumps(binding)),
                                     files={"file": ("photo.jpg", (ROOT / "datasets/r6_yizumi/development.jpg").read_bytes(), "image/jpeg")})

    response = asyncio.run(upload(hint))
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["compatibility"]["code"] == "PAGE_COMPATIBLE"
    observation = result["page_observations"]
    validate_raw_record(observation, package)
    assert observation["image_sha256"] == hashlib.sha256((ROOT / "datasets/r6_yizumi/development.jpg").read_bytes()).hexdigest()
    assert observation["coverage"]["status"] == "partial"
    record_evidence("live-http", result)
    hint_path = root / "hint.json"
    hint_path.write_text(json.dumps(hint))
    command = [sys.executable, str(ROOT / "scripts/extract_fields.py"), "development", "--rectified-dir", str(real_images[1]),
               "--output-dir", str(root / "extracted"), "--templates-dir", str(root / "templates"),
               "--labels", str(root / "absent"), "--record-report", str(root / "absent"), "--observations-version", "v2",
               "--original-image", str(ROOT / "datasets/r6_yizumi/development.jpg"), "--controller-hint", str(hint_path)]
    process = subprocess.run(command, capture_output=True, text=True, timeout=60)
    assert process.returncode == 0, process.stdout + process.stderr
    cli = json.loads((root / "extracted/development.fields.json").read_text())
    validate_raw_record(cli["page_observations"], package)
    assert cli["compatibility"]["code"] == "PAGE_COMPATIBLE"
    assert cli["page_observations"]["package_sha256"] == observation["package_sha256"]
    truth = json.loads((ROOT / "datasets/r6_yizumi/development.truth.json").read_text())["values"]
    for document in (observation, cli["page_observations"]):
        for field in document["fields"]:
            if field["reading"] == "known":
                assert field["original_value"] == pytest.approx(truth[field["screen_field_key"]])
    record_evidence("live-cli", cli)
    hint["pages"][0]["package_sha256"] = "0" * 64
    response = asyncio.run(upload(hint))
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "PAGE_PACKAGE_INCOMPATIBLE"
    record_evidence("live-http-wrong-hash", response.json())


def test_a07_missing_count_landmarks_cli_rejects_with_original_evidence(published, real_images):
    root, _, package = published
    directory = root / "missing-landmarks"
    directory.mkdir()
    original = real_images[2]["development"]
    ocr = copy.deepcopy(original["ocr_evidence"])
    removed = [line for line in ocr["lines"] if line["text"].strip() == "段数"]
    assert len(removed) == 2
    ocr["lines"] = [line for line in ocr["lines"] if line["text"].strip() != "段数"]
    (directory / "development.ocr.json").write_text(json.dumps(ocr))
    (directory / "development.rectify.json").write_text(json.dumps(original["transform"]))
    shutil.copyfile(real_images[1] / "development.png", directory / "development.png")
    hint = dict(brand="YIZUMI", controller_family="YIZUMI", interface_generation=None,
                binding_revision=1, pages=[dict(profile_id=P11, version=package["version"], package_sha256=canonical_hash(package))])
    hint_path = root / "hint.json"
    hint_path.write_text(json.dumps(hint))
    command = [sys.executable, str(ROOT / "scripts/extract_fields.py"), "development", "--rectified-dir", str(directory),
               "--output-dir", str(directory / "result"), "--templates-dir", str(root / "templates"),
               "--labels", str(root / "absent"), "--record-report", str(root / "absent"), "--observations-version", "v2",
               "--original-image", str(ROOT / "datasets/r6_yizumi/development.jpg"), "--controller-hint", str(hint_path)]
    process = subprocess.run(command, capture_output=True, text=True, timeout=60)
    record_evidence("missing-landmarks-cli-command", dict(argv=command, exit=process.returncode,
                    stdout=process.stdout, stderr=process.stderr, synthetic="count OCR lines removed from real CPU OCR"))
    assert process.returncode == 0, process.stdout + process.stderr
    assert "Traceback" not in process.stderr
    result = json.loads((directory / "result/development.fields.json").read_text())
    assert result["status"] == "reject" and not result.get("fields") and not result.get("page_observations")
    assert not result.get("extraction_detail")
    assert result["raw_rejection"]["code"] == "RAW_PAGE_LAYOUT_CONFLICT"
    assert result["raw_rejection"]["profile_id"] == P11
    assert result["raw_rejection"]["action"] == "review_or_recapture_full_screen"
    assert result["raw_rejection"]["reason"]
    assert result["raw_ocr_evidence"]["lines"] == ocr["lines"]
    assert not any("GENERIC_FALLBACK" in warning for warning in result["warnings"])
    record_evidence("missing-landmarks-cli", result)


def test_a07_masked_count_labels_real_http_returns_actionable_rejection(published, real_images, monkeypatch):
    import cv2
    import tempfile
    import hmi_service as service
    from extract_families.coordinates import project_boxes

    root, _, package = published
    monkeypatch.setattr(service, "HERE", root)
    monkeypatch.setattr(service, "ocr_model", real_images[0])
    monkeypatch.setattr(service, "is_ready", True)
    monkeypatch.setattr(service, "concurrency_semaphore", asyncio.Semaphore(1))
    monkeypatch.delenv("HMI_API_KEY", raising=False)
    temporary = OUTPUT / "http-tmp"
    temporary.mkdir(exist_ok=True)
    monkeypatch.setattr(tempfile, "tempdir", str(temporary))
    original = real_images[2]["development"]
    labels = [line for line in original["ocr_evidence"]["lines"] if line["text"].strip() == "段数"]
    assert len(labels) == 2
    boxes = [dict(bbox=[line["bbox"][key] for key in ("x_min", "y_min", "x_max", "y_max")]) for line in labels]
    project_boxes(boxes, original["transform"])
    photo = cv2.imread(str(ROOT / "datasets/r6_yizumi/development.jpg"))
    height, width = photo.shape[:2]
    for box in boxes:
        x1, y1, x2, y2 = box["original_bbox"]
        cv2.rectangle(photo, (int(x1 * width / 100) - 5, int(y1 * height / 100) - 5),
                      (int(x2 * width / 100) + 5, int(y2 * height / 100) + 5), (210, 210, 210), -1)
    masked = OUTPUT / "synthetic-missing-count-labels.jpg"
    assert cv2.imwrite(str(masked), photo)
    hint = dict(brand="YIZUMI", controller_family="YIZUMI", interface_generation=None,
                binding_revision=1, pages=[dict(profile_id=P11, version=package["version"], package_sha256=canonical_hash(package))])

    async def upload():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://reader") as client:
            return await client.post("/api/v1/recognize", params=dict(observations_version="v2", controller_hint=json.dumps(hint)),
                                     files={"file": (masked.name, masked.read_bytes(), "image/jpeg")})

    response = asyncio.run(upload())
    record_evidence("missing-landmarks-http", dict(status=response.status_code, body=response.json(),
                    image_sha256=hashlib.sha256(masked.read_bytes()).hexdigest(), masked_regions=boxes,
                    synthetic="Two count-label regions masked; all other pixels from development original"))
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "RAW_PAGE_LAYOUT_CONFLICT" and detail["profile_id"] == P11
    assert detail["reason"] and detail["action"] == "review_or_recapture_full_screen"
    assert not response.json().get("page_observations")


def test_a07_layout_rejection_does_not_hide_image_identity_error(real_images):
    from raw_observations import observe_temperature_time_page, RawPageRejected

    original = real_images[2]["development"]
    lines = [line for line in original["ocr_evidence"]["lines"] if line["text"].strip() != "段数"]
    with pytest.raises(ValueError, match="^IMAGE_HASH_INVALID$") as caught:
        observe_temperature_time_page(P11, lines, original["transform"], "invalid")
    assert not isinstance(caught.value, RawPageRejected)
