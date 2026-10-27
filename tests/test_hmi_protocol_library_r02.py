"""R02 behavior gate, with live CPU OCR, HTTP uploads and CLI subprocesses."""
import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
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
import page_template_lifecycle as lifecycle
from controller_binding import content_hash
from export_page_package import export_page_package
from extract_fields import extract_one
from rectify import rectify

OUTPUT = Path(os.environ.get("AP_GRAPH_OUTPUT_DIR", ROOT / "output/r02"))
PREFIX = "/api/v1/page-templates"
HEADERS = {"Authorization": "Bearer r02-isolated"}
SPECS = {
    "br": ("b_and_r.injection_metering.real_photo", "b_and_r/injection_holding.json",
           "ground_truth/bole_BR/射胶保压_20260807180631_13_32.jpg",
           ["射胶", "保压切换", "外部信号"]),
    "brtemp": ("b_and_r.temperature.real_photo", "b_and_r.temperature.json",
               "ground_truth/bole_BR/温度_20260807180630_12_32.jpg",
               ["料筒温度", "设定温度", "高温偏差", "低温偏差"]),
    "est": ("est.injection_metering.real_photo", "est.injection_metering.json",
            "ground_truth/bole_est/EST2/Luban_17750312447933d93f198-2093-4e12-a43f-7fa56a7b80cf.jpeg",
            ["转保压方式", "终止位置", "保压位置"]),
}


def record(name, value):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / f"{name}.json").write_text(json.dumps(value, ensure_ascii=False, indent=2))


@pytest.fixture(scope="module")
def live():
    from paddleocr import PaddleOCR
    OUTPUT.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="live-", dir=OUTPUT))
    models = OUTPUT / "models"
    engine = PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False,
                       det_model_dir=str(models / "det"), rec_model_dir=str(models / "rec"),
                       cls_model_dir=str(models / "cls"))
    samples = {}
    for key, (_, _, image, _) in SPECS.items():
        image = ROOT / image
        meta = rectify(image, directory / f"{key}.png", directory / f"{key}.rectify.json")
        assert meta["ok"], meta
        raw = engine.ocr(str(directory / f"{key}.png"), cls=False)
        lines = []
        for points, (text, confidence) in raw[0] or []:
            xs, ys = zip(*points)
            lines.append(dict(text=text, conf=float(confidence), bbox=dict(
                x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
        assert lines
        ocr = {"lines": lines, "model": "PaddleOCR CPU PP-OCRv4", "screen_size": meta["screen_size"]}
        (directory / f"{key}.ocr.json").write_text(json.dumps(ocr))
        samples[key] = {"manifest": {"sample_id": key,
                        "original_sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
                        "original_size": meta["original_size"], "screen_size": meta["screen_size"],
                        "original_path": str(image.relative_to(ROOT)),
                        "purpose": "development_exposed_not_independent_test"}, "ocr": ocr}
    record("live-samples", samples)
    return engine, directory, samples


@pytest.fixture
def storage(live, monkeypatch):
    root = Path(tempfile.mkdtemp(prefix="storage-", dir=OUTPUT))
    (root / "contracts").mkdir()
    (root / "templates").mkdir()
    (root / "contracts/profiles.json").write_text('{"profiles": []}')
    monkeypatch.setattr(admin, "ROOT", root)
    monkeypatch.setattr(service, "HERE", root)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "r02-isolated")
    monkeypatch.delenv("HMI_API_KEY", raising=False)
    app = FastAPI()
    app.include_router(admin.router)
    client = TestClient(app)
    requests = {}
    for key, (pid, path, _, anchors) in SPECS.items():
        template = json.loads((ROOT / "templates" / path).read_text())
        template.update(profile_id=pid, version="1.0.0", layout_variant=key,
                        extractor="registered_extractor", extractor_id=f"{template['ui_family'].lower()}.{template['page']}",
                        extractor_version="1", sample_ids=[key], layout_anchors=anchors,
                        business_profile_candidate=template.get("business_profile_candidate", {}))
        template["page_identity"] = dict(brand="BOLE", controller_family=template["ui_family"],
                                         interface_generation=None, page_type=template["page"],
                                         layout_variant=key, evidence_sample_ids=[key])
        sample = copy.deepcopy(live[2][key])
        sample["manifest"]["profile_id"] = pid
        request = dict(expected_version=None, template=template, samples=[sample])
        requests[key] = request
        response = client.put(f"{PREFIX}/drafts/{pid}", json=request, headers=HEADERS)
        assert response.status_code == 200, response.text
        response = client.post(f"{PREFIX}/drafts/{pid}/publish", json=dict(
            expected_revision=1, expected_version=None, confirmation="publish_confirmed"), headers=HEADERS)
        assert response.status_code == 200, response.text
    return root, client, requests


def binding(root, *keys):
    references = []
    for key in keys:
        pid = SPECS[key][0]
        package = export_page_package(pid, "1.0.0", root)
        references.append(dict(profile_id=pid, version="1.0.0", package_sha256=content_hash(package)))
    return dict(brand="BOLE", controller_family="EST" if keys[0] == "est" else "B_AND_R",
                interface_generation=None, binding_revision=1, pages=references)


def script(root, directory, key, hint):
    hint_file = root / "hint.json"
    hint_file.write_text(json.dumps(hint))
    command = [sys.executable, str(ROOT / "scripts/extract_fields.py"), key,
               "--rectified-dir", str(directory), "--output-dir", str(root / "extracted"),
               "--templates-dir", str(root / "templates"), "--record-report", str(root / "absent"),
               "--labels", str(root / "absent"), "--controller-hint", str(hint_file)]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads((root / "extracted" / f"{key}.fields.json").read_text())


def upload(live, key, hint, image_path=None):
    async def run():
        service.ocr_model = live[0]
        service.is_ready = True
        service.concurrency_semaphore = asyncio.Semaphore(1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app),
                                     base_url="http://reader") as client:
            return await client.post("/api/v1/recognize", params={"controller_hint": json.dumps(hint)},
                                     files={"file": ("photo.jpg", (image_path or ROOT / SPECS[key][2]).read_bytes(), "image/jpeg")})
    previous = service.ocr_model, service.is_ready, service.concurrency_semaphore
    try:
        response = asyncio.run(run())
    finally:
        service.ocr_model, service.is_ready, service.concurrency_semaphore = previous
    assert response.status_code == 200, response.text
    return response.json()


def rejected(result, code, status):
    assert result["status"] == "reject", result
    assert result["compatibility"]["code"] == code, result
    assert result["compatibility"]["status"] == status
    assert not result.get("fields"), result
    assert not any("GENERIC_FALLBACK" in warning for warning in result["warnings"])


def test_a06_live_two_controllers_same_brand_and_automatic_page_selection(storage, live):
    root, client, _ = storage
    hint = binding(root, "br", "brtemp")
    catalog = client.get(PREFIX).json()
    assert len(catalog) == 3
    assert {item["page_identity"]["controller_family"] for item in catalog} == {"B_AND_R", "EST"}
    results = {}
    for key in ("br", "brtemp", "est"):
        chosen_hint = binding(root, "est") if key == "est" else hint
        cli = script(root, live[1], key, chosen_hint)
        http = upload(live, key, chosen_hint)
        for result in (cli, http):
            assert result["compatibility"]["status"] == "compatible", result
            assert result["compatibility"]["profile_id"] == SPECS[key][0]
            assert result["profile_id"] == SPECS[key][0]
            assert result["fields"], result
            assert result["compatibility"]["page_identity"]["interface_generation"] is None
        assert cli["fields"] == http["fields"]
        results[key] = dict(script=cli, http=http)
        pid = SPECS[key][0]
        package = client.get(f"{PREFIX}/{pid}/package?version=1.0.0")
        assert package.status_code == 200
        assert package.json()["template"]["page_identity"]["brand"] == "BOLE"
    record("a06-live-http-script", results)


def test_a07_live_wrong_controller_never_falls_back(storage, live):
    root, _, _ = storage
    hint = binding(root, "br", "brtemp")
    results = [script(root, live[1], "est", hint), upload(live, "est", hint)]
    for result in results:
        rejected(result, "PAGE_BINDING_MISMATCH", "conflict")
    record("a07-wrong-binding", results)


def test_a07_live_unbound_page_is_unknown_without_fallback(storage, live):
    root, _, _ = storage
    image = ROOT / "ground_truth/bole_est/EST3/熔胶_20260807180626_8_32.jpg"
    result = upload(live, "est", binding(root, "est"), image_path=image)
    rejected(result, "PAGE_UNKNOWN", "unknown")
    record("a07-live-unknown-page", result)


def test_identity_without_evidence_cannot_publish_and_legacy_metadata_is_unverified(storage, live):
    root, client, requests = storage
    pid = SPECS["br"][0]
    request = copy.deepcopy(requests["br"])
    request.update(expected_version="1.0.0", expected_revision=1)
    request["template"]["version"] = "1.0.1"
    request["template"]["page_identity"]["evidence_sample_ids"] = ["not-in-package"]
    assert client.put(f"{PREFIX}/drafts/{pid}", json=request, headers=HEADERS).status_code == 422
    request["template"].pop("page_identity")
    assert client.put(f"{PREFIX}/drafts/{pid}", json=request, headers=HEADERS).status_code == 200
    response = client.post(f"{PREFIX}/drafts/{pid}/publish", json=dict(expected_revision=2,
        expected_version="1.0.0", confirmation="publish_confirmed"), headers=HEADERS)
    assert response.status_code == 200, response.text
    hint = binding(root, "br")
    package = client.get(f"{PREFIX}/{pid}/package?version=1.0.1").json()
    hint["pages"][0].update(version="1.0.1", package_sha256=content_hash(package))
    rejected(script(root, live[1], "br", hint), "CONTROLLER_METADATA_UNVERIFIED", "incompatible")


@pytest.mark.parametrize("case,code,status", [
    ("unknown", "PAGE_UNKNOWN", "unknown"),
    ("unknown_controller", "CONTROLLER_UNKNOWN", "unknown"),
    ("hash", "PAGE_PACKAGE_INCOMPATIBLE", "incompatible"),
    ("generation", "PAGE_BINDING_MISMATCH", "conflict"),
    ("contract", "EXTRACTOR_CONTRACT_INCOMPATIBLE", "incompatible"),
    ("conflict", "PAGE_TEMPLATE_CONFLICT", "conflict"),
])
def test_a07_distinct_rejection_results_through_script(storage, live, case, code, status):
    root, _, _ = storage
    hint = binding(root, "br")
    directory = live[1]
    if case == "unknown":
        directory = root / "unknown"
        directory.mkdir()
        (directory / "br.rectify.json").write_bytes((live[1] / "br.rectify.json").read_bytes())
        (directory / "br.ocr.json").write_text(json.dumps({"lines": [{"text": "unregistered page", "conf": .99,
            "bbox": {"x_min": 1, "y_min": 1, "x_max": 10, "y_max": 10}}]}))
    elif case == "unknown_controller":
        hint["pages"][0]["profile_id"] = "missing.page.layout"
    elif case == "hash":
        hint["pages"][0]["package_sha256"] = "0" * 64
    elif case == "generation":
        hint["interface_generation"] = "unverified-new-generation"
    else:
        pid = SPECS["br"][0]
        path = root / "templates/packages" / pid / "1.0.0.json"
        package = json.loads(path.read_text())
        if case == "contract":
            package["template"]["contract_version"] = "99.0.0"
            path.write_text(json.dumps(package))
            hint["pages"][0]["package_sha256"] = content_hash(package)
        else:
            entry = dict(profile_id="b_and_r.injection_metering.conflict", template="conflict.json")
            duplicate = {**package["template"], "profile_id": entry["profile_id"]}
            (root / "templates/conflict.json").write_text(json.dumps(duplicate))
            registry_path = root / "contracts/profiles.json"
            registry = json.loads(registry_path.read_text())
            registry["profiles"].append(entry)
            registry_path.write_text(json.dumps(registry))
    result = script(root, directory, "br", hint)
    rejected(result, code, status)
    record(f"a07-{case}", result)
    if case != "unknown":
        http = upload(live, "br", hint)
        rejected(http, code, status)
        record(f"a07-http-{case}", http)


def test_a07_controller_logo_conflict_cannot_be_overridden_by_page_anchors(storage, live):
    root, _, _ = storage
    directory = root / "opposite-logo"
    directory.mkdir()
    (directory / "br.rectify.json").write_bytes((live[1] / "br.rectify.json").read_bytes())
    ocr = copy.deepcopy(live[2]["br"]["ocr"])
    ocr["lines"].append(dict(text="FANUC ROBOSHOT", conf=1.0,
                             bbox=dict(x_min=1, y_min=1, x_max=100, y_max=20)))
    (directory / "br.ocr.json").write_text(json.dumps(ocr))
    result = script(root, directory, "br", binding(root, "br"))
    rejected(result, "PAGE_BINDING_MISMATCH", "conflict")
    record("a07-opposite-logo-and-matching-anchors", result)


def test_a14_disabled_publication_and_new_version_rollback_preserve_pins(storage, live):
    root, client, requests = storage
    pid = SPECS["br"][0]
    hint = binding(root, "br")
    old = client.get(f"{PREFIX}/{pid}/package?version=1.0.0").json()
    for revision, version, base, enabled in ((2, "1.0.1", "1.0.0", False),
                                              (3, "1.0.2", "1.0.1", True)):
        request = copy.deepcopy(requests["br"])
        request.update(expected_version=base, expected_revision=revision - 1)
        request["template"].update(version=version, enabled=enabled)
        response = client.put(f"{PREFIX}/drafts/{pid}", json=request, headers=HEADERS)
        assert response.status_code == 200, response.text
        response = client.post(f"{PREFIX}/drafts/{pid}/publish", json=dict(expected_version=base,
            expected_revision=revision, confirmation="publish_confirmed"), headers=HEADERS)
        assert response.status_code == 200, response.text
        result = script(root, live[1], "br", hint)
        if not enabled:
            rejected(result, "PAGE_TEMPLATE_DISABLED", "disabled")
            rejected(upload(live, "br", hint), "PAGE_TEMPLATE_DISABLED", "disabled")
        else:
            assert result["compatibility"]["version"] == "1.0.0"
            assert result["compatibility"]["package_sha256"] == content_hash(old)
        assert client.get(f"{PREFIX}/{pid}/package?version=1.0.0").json() == old
    reopened = TestClient(client.app).get(f"{PREFIX}/{pid}/package?version=1.0.0").json()
    assert reopened == old
    record("a14-reopened-pinned-package", reopened)


def test_a14_publication_storage_failure_keeps_old_active_combination(storage, monkeypatch):
    root, client, requests = storage
    pid = SPECS["br"][0]
    before = (root / "contracts/profiles.json").read_bytes()
    request = copy.deepcopy(requests["br"])
    request.update(expected_version="1.0.0", expected_revision=1)
    request["template"]["version"] = "1.0.1"
    assert client.put(f"{PREFIX}/drafts/{pid}", json=request, headers=HEADERS).status_code == 200
    original = lifecycle.atomic_json

    def fail_registry(path, value):
        if path == root / "contracts/profiles.json":
            raise OSError("injected publication disk failure")
        return original(path, value)

    monkeypatch.setattr(lifecycle, "atomic_json", fail_registry)
    response = client.post(f"{PREFIX}/drafts/{pid}/publish", json=dict(expected_version="1.0.0",
        expected_revision=2, confirmation="publish_confirmed"), headers=HEADERS)
    assert response.status_code == 503
    assert (root / "contracts/profiles.json").read_bytes() == before
    assert client.get(f"{PREFIX}/{pid}").json()["version"] == "1.0.0"
    record("a14-storage-failure", dict(status=response.status_code, detail=response.json()))


def test_invalid_hint_is_rejected_at_http_boundary_without_ocr(monkeypatch):
    monkeypatch.delenv("HMI_API_KEY", raising=False)
    response = TestClient(service.app).post("/api/v1/recognize", params={"controller_hint": "{}"},
                                           files={"file": ("invalid.jpg", b"invalid", "image/jpeg")})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "CONTROLLER_HINT_INVALID"
