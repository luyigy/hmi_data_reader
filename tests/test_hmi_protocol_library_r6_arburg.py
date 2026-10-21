"""R6 SELOGICA behavior on real originals, published packages and HTTP uploads."""

import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from raw_arburg import observe_selogica
from raw_contract import canonical_hash, import_raw_package, validate_raw_record
from extract_families.arburg_metering import PROFILE, extract_selogica
from extractor_registry import extract_registered
from extract_fields import extract_one, norm_tokens
from rectify import rectify
import page_template_admin as admin

OUTPUT = Path(os.environ["AP_GRAPH_OUTPUT_DIR"])
DATA = ROOT / "datasets/r6_arburg"
PREFIX = "/api/v1/page-templates"


def record(name, value):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / (name + ".json")).write_text(json.dumps(value, ensure_ascii=False, indent=2))


@pytest.fixture(scope="module")
def live():
    from paddleocr import PaddleOCR
    from raw_page_ocr import engine_identity

    OUTPUT.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="arburg-live-", dir=OUTPUT))
    engine = PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False)
    samples = {}
    for name in ("development", "retained", "injection-regression"):
        image = DATA / (name + ".jpg")
        meta = rectify(image, directory / (name + ".png"), directory / (name + ".rectify.json"))
        assert meta["ok"], meta
        result = engine.ocr(str(directory / (name + ".png")), cls=False)
        lines = []
        for points, (text, confidence) in result[0] or []:
            xs, ys = zip(*points)
            lines.append(dict(text=text, conf=float(confidence), bbox=dict(
                x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
        assert lines
        ocr = dict(lines=lines, engine_identity=engine_identity(engine))
        (directory / (name + ".ocr.json")).write_text(json.dumps(ocr, ensure_ascii=False))
        samples[name] = dict(meta=meta, ocr=ocr, sha256=hashlib.sha256(image.read_bytes()).hexdigest())
    record("live-image-identity", {key: dict(sha256=value["sha256"], meta=value["meta"], engine=value["ocr"]["engine_identity"])
                                   for key, value in samples.items()})
    return engine, directory, samples


@pytest.fixture
def storage(monkeypatch):
    root = Path(tempfile.mkdtemp(prefix="arburg-storage-", dir=OUTPUT))
    (root / "contracts").mkdir()
    (root / "contracts/profiles.json").write_text('{"profiles":[]}')
    monkeypatch.setattr(admin, "ROOT", root)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "arburg-isolated")
    app = FastAPI()
    app.include_router(admin.router)
    template = json.loads((ROOT / "templates/arburg/selogica_metering.json").read_text())
    samples = json.loads((DATA / "samples.json").read_text())
    headers = {"Authorization": "Bearer arburg-isolated"}
    with TestClient(app) as client:
        response = client.put(f"{PREFIX}/drafts/{PROFILE}", headers=headers,
                              json=dict(expected_version=None, template=template, samples=samples))
        assert response.status_code == 200, response.text
        trial = client.post(f"{PREFIX}/drafts/{PROFILE}/trial", headers=headers, json=dict(expected_revision=1))
        assert trial.status_code == 200, trial.text
        response = client.post(f"{PREFIX}/drafts/{PROFILE}/publish", headers=headers,
                               json=dict(expected_version=None, expected_revision=1, confirmation="publish_confirmed"))
        assert response.status_code == 200, response.text
        package = client.get(f"{PREFIX}/{PROFILE}/package", params={"version": "1.0.0"}).json()
    hint = dict(brand="ARBURG", controller_family="SELOGICA", interface_generation=None, binding_revision=1,
                pages=[dict(profile_id=PROFILE, version="1.0.0", package_sha256=canonical_hash(package))])
    return root, app, hint, package


def test_a17_source_inventory_and_development_retained_identity(live):
    inventory = json.loads((DATA / "inventory.json").read_text())
    assert inventory["all_query_pages_read"] is True
    assert inventory["records"] == 334 and len(inventory["references"]) == 983
    assert len({sample["sha256"] for sample in live[2].values()}) == 3
    for name in ("development", "retained"):
        truth = json.loads((DATA / (name + ".truth.json")).read_text())
        assert live[2][name]["sha256"] == truth["image_sha256"]
        assert truth["provenance"]["independent_acceptance"] is False
        assert (DATA / (name + ".source.json")).is_file()
    assert inventory["controller"] == "SELOGICA"
    assert inventory["coverage"]["temperature"] == "unsupported"
    assert inventory["coverage"]["holding"] == "unsupported"


@pytest.mark.parametrize("name", ["development", "retained"])
def test_a04_live_ocr_values_roles_unknown_and_missing(live, name):
    sample = live[2][name]
    observation = observe_selogica(sample["ocr"]["lines"], sample["meta"], sample["sha256"])
    observation["engine"] = sample["ocr"]["engine_identity"]
    package = json.loads((ROOT / "templates/packages" / PROFILE / "1.0.0.json").read_text())
    validate_raw_record(observation, package)
    by_key = {field["screen_field_key"]: field for field in observation["fields"]}
    truth = json.loads((DATA / (name + ".truth.json")).read_text())["values"]
    assert set(by_key) == set(truth)
    assert observation["coverage"]["status"] == "partial"
    for field in observation["fields"]:
        assert field["state"] == "unknown"
        if field["original_value"] is not None:
            assert field["original_value"] == truth[field["screen_field_key"]]
            assert field["bbox"] and field["original_bbox"]
        else:
            assert field["reading"] in ("missing", "unsupported")
    assert {by_key[key]["original_value"] for key in ("metering.speed.stage-1", "metering.speed.stage-2")} == {100.0}
    assert by_key["metering.end_position.stage-1"]["original_value"] == 20
    assert by_key["metering.end_position.stage-2"]["original_value"] == 27
    assert by_key["decompression.distance"]["original_value"] == 8
    assert by_key["time.remaining_cooling"]["role"] == "unknown"
    assert by_key["time.unlabeled_left"]["original_value"] == .1
    assert by_key["control.enable_icons"]["reading"] == "unsupported"
    assert by_key["metering.back_pressure.stage-2"]["reading"] == "missing"
    if name == "retained":
        assert by_key["metering.back_pressure.actual"]["original_value"] == -35
        assert by_key["metering.back_pressure.actual"]["role"] == "actual"
    record(name + "-observations", observation)


def test_a04_mutated_ocr_cannot_be_replaced_by_truth(live):
    sample = live[2]["retained"]
    template = json.loads((ROOT / "templates/arburg/selogica_metering.json").read_text())
    lines = copy.deepcopy(sample["ocr"]["lines"])
    source = next(line for line in lines if line["text"] == "20.00")
    source.update(text="19.25mm", conf=.3)
    fields = extract_selogica(lines, template, sample["meta"])["detail"]["page_observations"]["fields"]
    first = next(field for field in fields if field["screen_field_key"] == "metering.end_position.stage-1")
    assert first["original_value"] == 19.25 and first["reading"] == "uncertain" and first["state"] == "unknown"
    source["text"] = "19.25bar"
    fields = extract_selogica(lines, template, sample["meta"])["detail"]["page_observations"]["fields"]
    assert next(f for f in fields if f["screen_field_key"] == first["screen_field_key"])["reading"] == "conflict"
    lines.append(copy.deepcopy(source))
    fields = extract_selogica(lines, template, sample["meta"])["detail"]["page_observations"]["fields"]
    assert next(f for f in fields if f["screen_field_key"] == first["screen_field_key"])["original_value"] is None
    lines = [line for line in lines if line["text"] != "剩余冷却时间"]
    assert not extract_selogica(lines, template, sample["meta"])["detail"]


def test_a07_cli_binding_rejections_are_distinct_without_fallback(storage, live):
    root, _, hint, _ = storage
    directory = live[1]
    def run(binding):
        return extract_one("retained", directory, None, None, root / "templates", controller_hint=binding)
    success = run(hint)
    assert success["compatibility"]["status"] == "compatible", success
    results = {}
    wrong = copy.deepcopy(hint); wrong["controller_family"] = "GESTICA"
    bad_hash = copy.deepcopy(hint); bad_hash["pages"][0]["package_sha256"] = "0" * 64
    for key, binding, code in (("wrong", wrong, "PAGE_BINDING_MISMATCH"),
                                ("incompatible", bad_hash, "PAGE_PACKAGE_INCOMPATIBLE")):
        result = run(binding)
        assert result["status"] == "reject" and result["compatibility"]["code"] == code, result
        assert not result.get("fields") and not any("GENERIC_FALLBACK" in w for w in result["warnings"])
        results[key] = result
    path = root / "templates/published" / PROFILE / "1.0.0.json"
    template = json.loads(path.read_text()); template["enabled"] = False; path.write_text(json.dumps(template))
    result = run(hint)
    assert result["compatibility"]["code"] == "PAGE_TEMPLATE_DISABLED", result
    results["disabled"] = result
    template["enabled"] = True; path.write_text(json.dumps(template))
    blank = copy.deepcopy(live[2]["retained"]["ocr"]); blank["lines"] = blank["lines"][:1]
    (directory / "unknown.ocr.json").write_text(json.dumps(blank))
    (directory / "unknown.rectify.json").write_text(json.dumps(live[2]["retained"]["meta"]))
    result = extract_one("unknown", directory, None, None, root / "templates", controller_hint=hint)
    assert result["compatibility"]["code"] == "PAGE_UNKNOWN", result
    results["unknown"] = result
    template["profile_id"] = "arburg.storage_cooling.competing"
    path2 = root / "templates/competing.json"; path2.write_text(json.dumps(template))
    registry = json.loads((root / "contracts/profiles.json").read_text())
    registry["profiles"].append(dict(profile_id=template["profile_id"], template="competing.json"))
    (root / "contracts/profiles.json").write_text(json.dumps(registry))
    result = run(hint)
    assert result["compatibility"]["code"] == "PAGE_TEMPLATE_CONFLICT", result
    results["conflict"] = result
    record("a07-rejections", results)


def test_api_publication_independent_get_and_reopen(storage):
    root, app, _, package = storage
    frozen = root / "templates/packages" / PROFILE / "1.0.0.json"
    before = frozen.read_bytes()
    assert import_raw_package(package)["raw_field_definition"]["page_identity"]["controller_family"] == "SELOGICA"
    for _ in range(2):
        with TestClient(app) as reopened:
            response = reopened.get(f"{PREFIX}/{PROFILE}/package", params={"version": "1.0.0"})
        assert response.status_code == 200 and response.json() == package
    assert frozen.read_bytes() == before
    record("api-get-reopen", dict(package_sha256=canonical_hash(package), immutable=True))


def test_a07_contract_rejection_and_frozen_source_tampering(storage, live):
    root, _, hint, package = storage
    filename = root / "templates/packages" / PROFILE / "1.0.0.json"
    broken = copy.deepcopy(package)
    broken["template"]["contract_version"] = "unsupported"
    filename.write_text(json.dumps(broken))
    hint["pages"][0]["package_sha256"] = canonical_hash(broken)
    result = extract_one("retained", live[1], None, None, root / "templates", controller_hint=hint)
    assert result["status"] == "reject" and result["compatibility"]["code"] == "EXTRACTOR_CONTRACT_INCOMPATIBLE", result
    assert not result.get("fields")
    broken = copy.deepcopy(package)
    broken["recognizer"]["sources"]["scripts/raw_arburg.py"] += "\nchanged = True\n"
    filename.write_text(json.dumps(broken))
    sample = live[2]["retained"]
    with pytest.raises(ValueError, match="RAW_RECOGNIZER_HASH_MISMATCH"):
        observe_selogica(sample["ocr"]["lines"], sample["meta"], sample["sha256"], root)


def test_http_draft_permission_and_import_boundary(storage):
    root, app, _, package = storage
    template = copy.deepcopy(package["template"])
    before = (root / "contracts/profiles.json").read_bytes()
    with TestClient(app) as client:
        body = dict(expected_version="1.0.0", expected_revision=1, template=template, samples=package["samples"])
        denied = client.put(f"{PREFIX}/drafts/{PROFILE}", json=body)
        assert denied.status_code == 401
        template["extractor_id"] = "os.system"
        rejected = client.put(f"{PREFIX}/drafts/{PROFILE}", json=body,
                              headers={"Authorization": "Bearer arburg-isolated"})
        assert rejected.status_code == 422 and "EXTRACTOR_ID_UNREGISTERED" in rejected.text
    assert (root / "contracts/profiles.json").read_bytes() == before


def test_a11_a18_reverse_legacy_injection_keeps_stage_identity(live):
    import cv2
    from extract_families.arburg_injection import extract_injection_arburg
    sample = live[2]["injection-regression"]
    template = json.loads((ROOT / "templates/arburg.injection_metering.json").read_text())
    tokens = norm_tokens(sample["ocr"], sample["meta"]["screen_size"])
    width, height = sample["meta"]["screen_size"]
    image = cv2.imread(str(live[1] / "injection-regression.png"))
    crop = cv2.resize(image[int(.28 * height):int(.42 * height), :int(.45 * width)], None, fx=3, fy=3)
    sidecar = live[0].ocr(crop, cls=False)
    lines = []
    for points, (text, confidence) in sidecar[0] or []:
        xs, ys = zip(*points)
        lines.append(dict(text=text, conf=float(confidence), _src="delay_box", bbox=dict(
            x_min=min(xs) / 3, x_max=max(xs) / 3,
            y_min=min(ys) / 3 + int(.28 * height), y_max=max(ys) / 3 + int(.28 * height))))
    record("legacy-delay-live-ocr", dict(lines=lines))
    tokens += norm_tokens(dict(lines=lines), sample["meta"]["screen_size"])
    result = extract_injection_arburg(tokens, template)
    record("legacy-injection-live", result)
    truth = json.loads((ROOT / "ground_truth/inj_z068_injection/inj_Z068_20250710_rank01_recuQJJQEdw72j.truth.json").read_text())["fields"]
    assert result["fields"] == truth, result
    new = json.loads((ROOT / "templates/packages" / PROFILE / "1.0.0.json").read_text())
    for filename in (ROOT / "templates/raw-packages").rglob("*.json"):
        import_raw_package(json.loads(filename.read_text()))
    assert not any("stage_enabled" in field for field in new["raw_field_definition"]["fields"])


def test_real_http_upload_v2_and_cli_use_same_package(storage, live, monkeypatch):
    import hmi_service as service
    root, _, hint, package = storage
    monkeypatch.setattr(service, "HERE", root)
    monkeypatch.setattr(service.tempfile, "tempdir", str(OUTPUT))
    monkeypatch.delenv("HMI_API_KEY", raising=False)
    monkeypatch.setattr(service, "ocr_model", live[0])
    monkeypatch.setattr(service, "is_ready", True)
    monkeypatch.setattr(service, "concurrency_semaphore", asyncio.Semaphore(1))
    async def upload(binding):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://reader") as client:
            return await client.post("/api/v1/recognize", params=dict(observations_version="v2", controller_hint=json.dumps(binding)),
                                     files={"file": ("photo.jpg", (DATA / "retained.jpg").read_bytes(), "image/jpeg")})
    response = asyncio.run(upload(hint))
    assert response.status_code == 200, response.text
    payload = response.json(); record("http-live-v2", payload)
    observation = payload["page_observations"]
    validate_raw_record(observation, package)
    assert observation["image_sha256"] == live[2]["retained"]["sha256"]
    assert observation["package_sha256"] == canonical_hash(package)
    assert all(field["state"] == "unknown" for field in observation["fields"])
    bad = copy.deepcopy(hint); bad["controller_family"] = "GESTICA"
    response = asyncio.run(upload(bad))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "PAGE_BINDING_MISMATCH", response.text
    hint_file = OUTPUT / "arburg-hint.json"; hint_file.write_text(json.dumps(hint))
    command = [sys.executable, str(ROOT / "scripts/extract_fields.py"), "retained", "--rectified-dir", str(live[1]),
               "--output-dir", str(OUTPUT / "cli"), "--templates-dir", str(root / "templates"),
               "--controller-hint", str(hint_file), "--observations-version", "v2", "--original-image", str(DATA / "retained.jpg"),
               "--record-report", str(OUTPUT / "absent"), "--labels", str(OUTPUT / "absent")]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=90, cwd=ROOT)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    cli = json.loads((OUTPUT / "cli/retained.fields.json").read_text())["page_observations"]
    assert cli["package_sha256"] == observation["package_sha256"]
    assert cli["image_sha256"] == observation["image_sha256"]
