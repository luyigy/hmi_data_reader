"""R02B real HTTP/CLI lifecycle, using frozen OCR and disposable filesystem storage."""
import json
import os
from pathlib import Path
import subprocess
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import page_template_admin as admin
import page_template_lifecycle as lifecycle
from scripts.export_page_package import export_page_package
from scripts.extract_fields import extract_one

ROOT = Path(__file__).resolve().parents[1]
HEADERS = {"Authorization": "Bearer lifecycle-test"}
PID = "tact5.process_settings.reusable"
PREFIX = "/api/v1/page-templates"


@pytest.fixture
def storage(tmp_path, monkeypatch):
    (tmp_path / "contracts").mkdir()
    (tmp_path / "contracts/profiles.json").write_text(json.dumps({"profiles": []}))
    monkeypatch.setattr(admin, "ROOT", tmp_path)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "lifecycle-test")
    app = FastAPI()
    app.include_router(admin.router)
    return tmp_path, TestClient(app)


def body(profile_id=PID, version="0.1.0", expected_version=None):
    old_id = "tact5.process_settings.injection_holding_metering"
    template = json.loads((ROOT / "templates" / f"{old_id}.json").read_text())
    template.update(profile_id=profile_id, version=version, extractor="registered_extractor",
                    extractor_id="tact5.process_settings", extractor_version="1")
    manifest = json.loads((ROOT / "templates/samples" / old_id / f"{template['sample_ids'][0]}.json").read_text())
    ocr = json.loads((ROOT / manifest["ocr_fixture"]).read_text())
    manifest["profile_id"] = profile_id
    return {"expected_version": expected_version, "template": template,
            "samples": [{"manifest": manifest, "ocr": ocr}]}


def save(client, request, profile_id=PID):
    response = client.put(f"{PREFIX}/drafts/{profile_id}", json=request, headers=HEADERS)
    assert response.status_code == 200, response.text
    return response.json()


def publish(client, profile_id=PID, revision=1, expected_version=None):
    return client.post(f"{PREFIX}/drafts/{profile_id}/publish", headers=HEADERS,
                       json={"expected_revision": revision, "expected_version": expected_version,
                             "confirmation": "publish_confirmed"})


def trial(client, revision=1):
    response = client.post(f"{PREFIX}/drafts/{PID}/trial", headers=HEADERS,
                           json={"expected_revision": revision})
    assert response.status_code == 200, response.text
    return response.json()


def cli(root, command, profile_id=PID, payload=None):
    args = [sys.executable, str(ROOT / "scripts/manage_page_templates.py"), "--root", str(root), command, profile_id]
    if payload is not None:
        path = root / "request.json"
        path.write_text(json.dumps(payload))
        args += ["--body", str(path)]
    return subprocess.run(args, cwd=ROOT, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                          capture_output=True, text=True, timeout=40)


def test_http_create_trial_publish_freeze_and_disable(storage):
    root, client = storage
    request = body()
    url = f"{PREFIX}/drafts/{PID}"
    assert client.put(url, json=request).status_code == 401
    assert client.get(url).status_code == 401
    save(client, request)
    assert client.get(f"{PREFIX}/{PID}").status_code == 404
    assert client.get(PREFIX).json() == []
    initial = trial(client)
    assert initial["before"] == [] and initial["after"][0]["result"]["detail"]["page_observations"]["fields"]
    first = publish(client)
    assert first.status_code == 200, first.text
    frozen = client.get(f"{PREFIX}/{PID}/package").json()
    assert frozen["template"]["extractor_id"] == "tact5.process_settings"
    assert frozen["samples"][0]["ocr_content_sha256"]
    assert frozen["template"]["contract_version"] == "2.11.0"
    active = client.get(f"{PREFIX}/{PID}").json()["template"]
    assert client.put(f"{PREFIX}/{PID}", headers=HEADERS, json={"expected_version": "0.1.0",
        "template": active, "confirmation": "save_confirmed"}).status_code == 409
    request = body(version="0.1.1", expected_version="0.1.0")
    request["expected_revision"] = 1
    request["template"]["field_labels"]["冷却"]["label"] = "冷却时间"
    save(client, request)
    diff = trial(client, 2)
    assert diff["changed"]
    before = diff["before"][0]["result"]["detail"]["page_observations"]["fields"]
    after = diff["after"][0]["result"]["detail"]["page_observations"]["fields"]
    assert next(f for f in before if f["label"] == "冷却")["unit"] == "s"
    assert not any(f["label"] == "冷却" for f in after)
    assert next(f for f in after if f["label"] == "冷却时间")["unit"] == "s"
    assert publish(client, revision=2, expected_version="0.1.0").status_code == 200
    assert client.get(f"{PREFIX}/{PID}/package?version=0.1.0").json() == frozen
    assert client.get(f"{PREFIX}/{PID}/versions").status_code == 200
    request = body(version="0.1.2", expected_version="0.1.1")
    request.update(expected_revision=2)
    request["template"]["enabled"] = False
    save(client, request)
    assert publish(client, revision=3, expected_version="0.1.1").json()["enabled"] is False
    assert client.get(PREFIX).json() == [{"profile_id": PID, "version": "0.1.2", "enabled": False}]
    assert client.get(f"{PREFIX}/{PID}/package?version=0.1.0").json() == frozen


def test_cli_http_share_contract_and_same_ocr_multiple_templates(storage):
    root, client = storage
    request = body()
    result = cli(root, "save", payload=request)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == client.get(f"{PREFIX}/drafts/{PID}", headers=HEADERS).json()
    cli_trial = cli(root, "trial", payload={"expected_revision": 1})
    assert cli_trial.returncode == 0, cli_trial.stderr
    assert json.loads(cli_trial.stdout) == trial(client)
    result = cli(root, "publish", payload={"expected_revision": 1, "expected_version": None,
                                           "confirmation": "publish_confirmed"})
    assert result.returncode == 0, result.stderr
    second_id = "tact5.process_settings.second"
    second = body(second_id)
    save(client, second, second_id)
    assert publish(client, second_id).status_code == 200
    one = export_page_package(PID, "0.1.0", root)
    two = export_page_package(second_id, "0.1.0", root)
    assert one["samples"][0]["ocr"] == two["samples"][0]["ocr"]
    assert one["template"]["extractor_id"] == two["template"]["extractor_id"]


@pytest.mark.parametrize("change", [
    {"extractor": "os.system"}, {"extractor": "page_module"}, {"extractor_id": "os.system"},
    {"extractor_id": "../../evil"}, {"extractor_version": "99"},
    {"contract_version": "99"}, {"import_path": "os.system"}, {"enabled": "false"},
    {"layout_anchors": ["["]},
])
def test_invalid_configuration_is_rejected_without_activating(storage, change):
    root, client = storage
    request = body()
    request["template"].update(change)
    response = client.put(f"{PREFIX}/drafts/{PID}", headers=HEADERS, json=request)
    assert response.status_code == 422, response.text
    assert json.loads((root / "contracts/profiles.json").read_text()) == {"profiles": []}


def test_publish_failure_and_revision_conflicts_preserve_previous(storage, monkeypatch):
    root, client = storage
    save(client, body())
    assert publish(client).status_code == 200
    previous = client.get(f"{PREFIX}/{PID}/package").json()
    request = body(version="0.1.1", expected_version="0.1.0")
    request["expected_revision"] = 1
    save(client, request)
    assert publish(client, revision=1, expected_version="0.1.0").status_code == 409
    assert publish(client, revision=2).status_code == 409
    original_write = lifecycle.atomic_json
    def fail_pointer(path, value):
        if path == root / "contracts/profiles.json":
            raise OSError("injected pointer write failure")
        original_write(path, value)
    monkeypatch.setattr(lifecycle, "atomic_json", fail_pointer)
    failed = publish(client, revision=2, expected_version="0.1.0")
    assert failed.status_code == 503, failed.text
    assert client.get(f"{PREFIX}/{PID}/package").json() == previous
    assert client.get(f"{PREFIX}/{PID}").json()["version"] == "0.1.0"
    assert client.get(f"{PREFIX}/{PID}/versions").status_code == 200
    assert client.get(f"{PREFIX}/{PID}/package?version=0.1.1").status_code == 404
    monkeypatch.setattr(lifecycle, "atomic_json", original_write)
    assert publish(client, revision=2, expected_version="0.1.0").status_code == 200
    assert publish(client, revision=2, expected_version="0.1.0").status_code == 409
    assert client.put(f"{PREFIX}/drafts/{PID}", headers=HEADERS, json=request).status_code == 409


def test_failed_trial_cannot_publish(storage):
    root, client = storage
    request = body()
    request["samples"][0]["ocr"]["lines"] = [{"text": "not a page", "bbox": [0, 0, 5, 5]}]
    save(client, request)
    response = publish(client)
    assert response.status_code == 422, response.text
    assert client.get(f"{PREFIX}/{PID}").status_code == 404


@pytest.mark.parametrize("case,warning", [
    ("disabled", "PAGE_TEMPLATE_DISABLED"), ("conflict", "PAGE_TEMPLATE_CONFLICT"),
    ("incompatible", "EXTRACTOR_VERSION_INCOMPATIBLE"),
])
def test_lifecycle_routes_cannot_fallback_to_process_fields(storage, case, warning):
    root, client = storage
    request = body()
    if case == "disabled":
        request["template"]["enabled"] = False
    save(client, request)
    assert publish(client).status_code == 200
    if case == "conflict":
        pid = "tact5.process_settings.conflicting"
        save(client, body(pid), pid)
        assert publish(client, pid).status_code == 200
    if case == "incompatible":
        # Simulate a frozen configuration produced by a newer Reader runtime.
        registry = json.loads((root / "contracts/profiles.json").read_text())
        active = root / "templates" / registry["profiles"][0]["template"]
        template = json.loads(active.read_text())
        template["extractor_version"] = "99"
        active.write_text(json.dumps(template))
    directory = root / "rectified"
    directory.mkdir()
    (directory / "same.ocr.json").write_text(json.dumps(request["samples"][0]["ocr"]))
    (directory / "same.rectify.json").write_text(json.dumps({"ok": True, "screen_size": [1920, 1080]}))
    result = extract_one("same", directory, {}, {}, root / "templates")
    assert result["status"] == "reject", result
    assert result.get("fields") is None
    assert warning in result["warnings"]
    assert not any(w.startswith("GENERIC_FALLBACK") for w in result["warnings"])


def test_legacy_page_module_package_and_upgrade_keep_pinned_evidence(storage):
    root, client = storage
    profile_id = "yizumi.injection_metering.metering_f2"
    registry = json.loads((ROOT / "contracts/profiles.json").read_text())
    entry = next(p for p in registry["profiles"] if p["profile_id"] == profile_id)
    (root / "contracts/profiles.json").write_text(json.dumps({"profiles": [entry]}))
    old = export_page_package(profile_id, "0.1.0", ROOT)
    active = root / "templates" / entry["template"]
    active.parent.mkdir(parents=True)
    active.write_text(json.dumps(old["template"]))
    for sample in old["samples"]:
        manifest = sample["manifest"]
        sample_path = root / "templates/samples" / profile_id / f"{manifest['sample_id']}.json"
        sample_path.parent.mkdir(parents=True, exist_ok=True)
        sample_path.write_text(json.dumps(manifest))
        fixture_path = root / manifest["ocr_fixture"]
        fixture_path.parent.mkdir(parents=True, exist_ok=True)
        fixture_path.write_bytes((ROOT / manifest["ocr_fixture"]).read_bytes())
    assert client.get(f"{PREFIX}/{profile_id}/package").json() == old
    template = {**old["template"], "version": "0.1.1", "extractor": "registered_extractor",
                "extractor_id": "yizumi.metering_f2"}
    request = {"expected_version": "0.1.0", "template": template, "samples": old["samples"]}
    save(client, request, profile_id)
    published = publish(client, profile_id, expected_version="0.1.0")
    assert published.status_code == 200, published.text
    assert not published.json()["trial"]["changed"]
    fixture_path.write_text("{}")
    assert client.get(f"{PREFIX}/{profile_id}/package?version=0.1.0").json() == old
    assert client.get(f"{PREFIX}/{profile_id}/versions").status_code == 200


def test_cannot_skip_patch_versions_or_change_frozen_content(storage):
    root, client = storage
    save(client, body())
    assert publish(client).status_code == 200
    request = body(version="0.1.2", expected_version="0.1.0")
    request["expected_revision"] = 1
    save(client, request)
    assert publish(client, revision=2, expected_version="0.1.0").status_code == 409
    assert client.get(f"{PREFIX}/{PID}").json()["version"] == "0.1.0"
    request = body(version="0.1.1", expected_version="0.1.0")
    request["expected_revision"] = 2
    save(client, request)
    assert publish(client, revision=3, expected_version="0.1.0").status_code == 200
    pinned = client.get(f"{PREFIX}/{PID}/package?version=0.1.0").json()
    request = body(version="0.1.0", expected_version="0.1.1")
    request["expected_revision"] = 3
    request["template"]["field_labels"] = {}
    save(client, request)
    assert publish(client, revision=4, expected_version="0.1.1").status_code == 409
    assert client.get(f"{PREFIX}/{PID}/package?version=0.1.0").json() == pinned


def test_hot_publication_recognition_receipt_uses_selected_identity(storage, monkeypatch):
    import contract
    root, client = storage
    monkeypatch.setattr(contract, "CONTRACTS_DIR", root / "contracts")
    (root / "contracts/field_catalog.json").write_bytes((ROOT / "contracts/field_catalog.json").read_bytes())
    assert contract._profile_registry() == {}
    request = body()
    save(client, request)
    assert publish(client).status_code == 200
    directory = root / "rectified"
    directory.mkdir()
    (directory / "same.ocr.json").write_text(json.dumps(request["samples"][0]["ocr"]))
    (directory / "same.rectify.json").write_text(json.dumps({"ok": True, "screen_size": [1920, 1080]}))
    result = extract_one("same", directory, {}, {}, root / "templates")
    assert result["profile_id"] == PID
    assert result["profile_status"] == "candidate"
    assert result["template_version"] == "0.1.0"
    assert result["extraction_detail"]["page_observations"]["fields"]
    # A reused extractor may still declare its original hardcoded page identity.
    result["extraction_detail"]["page_observations"]["profile_id"] = "tact5.process_settings.legacy"
    assert contract.attach_contract(result)["profile_id"] == PID
    assert result["extraction_detail"]["page_observations"]["profile_id"] == PID
