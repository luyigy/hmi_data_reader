"""Offline R02 regression: real CLI processes and HTTP routes share controlled extraction."""
import asyncio
import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import hmi_service as svc
from scripts.extract_fields import extract_page_fields, norm_tokens
from scripts.extractor_registry import _EXTRACTORS, capabilities
from scripts.quality import QualityReport

ROOT = Path(__file__).resolve().parents[1]
# Complete extractor output hashes captured from baseline 3e01a43, without an image.
LEGACY_REPLAY = {
    "demag/injection.json": "5a951a71d2b30d7becdb95ae881cf4fd2877c77da2c9f4ebf10816c037923264",
    "demag/holding.json": "8ff95be0b5bb30f23d8a6ca8425170a8f766380825925fba63e105de9bb35bc9",
    "demag/metering.json": "b443b958001e39983fdd3f66554eeb29a6f6e583dae9b744db1c646f3f1f06c5",
    "fanuc/injection_metering.json": "2f9e192f0b2896a6c08081dfe1aa8b48c6f63cc49f39ff88f3f92f135d20880e",
}


def fixture(name):
    data = json.loads((ROOT / "tests/fixtures" / name).read_text())
    for line in data["lines"]:
        box = line["bbox"]
        if isinstance(box, list):
            x1, y1, x2, y2 = box
            line["bbox"] = dict(x_min=x1, y_min=y1, x_max=x2, y_max=y2,
                                points=[[x1, y1], [x2, y1], [x2, y2], [x1, y2]])
        line["conf"] = line.get("conf", line.get("confidence", .99))
    return data


def cli(*args):
    return subprocess.run([sys.executable, "scripts/extract_fields.py", *map(str, args)],
                          cwd=ROOT, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                          text=True, capture_output=True, check=True)


def test_capabilities_http_cli_contract_and_auth(monkeypatch):
    monkeypatch.delenv("HMI_API_KEY", raising=False)
    client = TestClient(svc.app)
    response = client.get("/api/v1/capabilities")
    assert response.status_code == 200
    catalog = response.json()
    assert catalog == json.loads(cli("--capabilities").stdout) == capabilities()
    assert catalog["contract_version"] == "2.11.0"
    assert catalog["generic_fallback"] == {"unknown_only": True, "automatic_apply": False}
    for entry in catalog["extractors"]:
        module, name, kind, image, pages = _EXTRACTORS[entry["extractor_id"]]
        assert callable(getattr(importlib.import_module("scripts.extract_families." + module), name))
        assert (entry["input"], entry["image_support"], entry["pages"]) == (kind, image, list(pages))
    monkeypatch.setenv("HMI_API_KEY", "r02-offline")
    assert client.get("/api/v1/capabilities").status_code == 401
    assert client.get("/api/v1/capabilities", headers={"Authorization": "Bearer r02-offline"}).json() == catalog


@pytest.mark.parametrize("template_name,ocr_name,key,field,expected", [
    ("demag/injection.json", "demag_injection_z002_wehdt_ocr.json", "demag", "stage_velocity_mms", [75, 25]),
    ("demag/holding.json", "demag_holding_z002_ocr.json", "demag", "stage_holding_pressure_bar", None),
    ("demag/metering.json", "demag_metering_z002_ocr.json", "demag", "stage_back_pressure_bar", None),
    ("fanuc/injection_metering.json", "fanuc_injection_metering_z036_rank04_ocr.json",
     "fanuc.injection_metering", "injection_velocity_pct", None),
])
def test_existing_algorithms_replay_without_output_changes(template_name, ocr_name, key, field, expected):
    template = json.loads((ROOT / "templates" / template_name).read_text())
    data = fixture(ocr_name)
    tokens = norm_tokens(data, data["screen_size"])
    old = extract_page_fields(tokens, template, ocr_lines=data["lines"], meta=data)
    assert hashlib.sha256(json.dumps(old, sort_keys=True, ensure_ascii=False).encode()).hexdigest() == LEGACY_REPLAY[template_name]
    registered = {**template, "extractor": "registered_extractor", "extractor_id": key}
    assert extract_page_fields(tokens, registered, ocr_lines=data["lines"], meta=data) == old
    assert old["fields"]
    if expected is not None:
        assert old["fields"][field][:len(expected)] == expected


def test_page_module_compatibility_and_registered_ocr_adapter():
    template = json.loads((ROOT / "templates/yizumi/metering_f2.json").read_text())
    manifest = json.loads((ROOT / "templates/samples/yizumi.injection_metering.metering_f2/P12_31_20260930.json").read_text())
    data = fixture(Path(manifest["ocr_fixture"]).name)
    meta = {"screen_size": manifest["screen_size"]}
    old = extract_page_fields([], template, ocr_lines=data["lines"], meta=meta)
    assert old["detail"]["page_observations"]["fields"]
    registered = {**template, "extractor": "registered_extractor", "extractor_id": "yizumi.metering_f2"}
    assert extract_page_fields([], registered, ocr_lines=data["lines"], meta=meta) == old


@pytest.mark.parametrize("change,warning", [
    ({"extractor_id": "os.system"}, "EXTRACTOR_ID_UNREGISTERED"),
    ({"extractor_id": "../../evil"}, "EXTRACTOR_ID_UNREGISTERED"),
    ({"extractor_id": []}, "EXTRACTOR_ID_UNREGISTERED"),
    ({"extractor_version": "2"}, "EXTRACTOR_VERSION_INCOMPATIBLE"),
    ({"contract_version": "99.0.0"}, "EXTRACTOR_CONTRACT_INCOMPATIBLE"),
    ({"page": "waveform"}, "EXTRACTOR_PAGE_INCOMPATIBLE"),
    ({"enabled": False}, "PAGE_TEMPLATE_DISABLED"),
    ({"extractor": "generic_fallback"}, "PAGE_EXTRACTOR_INVALID"),
])
def test_invalid_registered_route_never_imports_or_extracts(change, warning, monkeypatch):
    import extractor_registry
    def forbidden(*args, **kwargs):
        pytest.fail("invalid template reached an extractor import")
    monkeypatch.setattr(extractor_registry, "import_module", forbidden)
    template = dict(extractor="registered_extractor", extractor_id="demag", page="injection_metering")
    result = extract_page_fields([], {**template, **change})
    assert result["fields"] is None
    assert result["warnings"] == [warning]


@pytest.mark.parametrize("case,warning", [
    ("legacy", None), ("registered", None), ("conflict", "PAGE_TEMPLATE_CONFLICT"),
    ("disabled", "PAGE_TEMPLATE_DISABLED"), ("version", "EXTRACTOR_VERSION_INCOMPATIBLE"),
    ("contract", "EXTRACTOR_CONTRACT_INCOMPATIBLE"), ("bad_id", "EXTRACTOR_ID_UNREGISTERED"),
    ("unknown", "GENERIC_FALLBACK"),
])
def test_cli_http_same_routing_with_fixed_ocr(case, warning, tmp_path, monkeypatch):
    shutil.copytree(ROOT / "templates", tmp_path / "templates")
    shutil.copytree(ROOT / "contracts", tmp_path / "contracts")
    path = tmp_path / "templates/demag/holding.json"
    template = json.loads(path.read_text())
    if case in ("registered", "version", "contract", "bad_id"):
        template.update(extractor="registered_extractor", extractor_id="demag")
    if case == "version":
        template["extractor_version"] = "2"
    if case == "contract":
        template["contract_version"] = "99.0.0"
    if case == "bad_id":
        template["extractor_id"] = "os.system"
    if case == "disabled":
        template["enabled"] = False
    template["family_detect_groups"] = ["实际切换"]
    path.write_text(json.dumps(template))
    if case == "conflict":
        other = {**template, "profile_id": "demag.injection_metering.conflict"}
        (tmp_path / "templates/demag/conflict.json").write_text(json.dumps(other))
        profiles = tmp_path / "contracts/profiles.json"
        registry = json.loads(profiles.read_text())
        registry["profiles"].append({"profile_id": other["profile_id"], "template": "demag/conflict.json"})
        profiles.write_text(json.dumps(registry))
    data = fixture("demag_holding_z002_ocr.json")
    if case == "unknown":
        data["lines"] = []
    rectified = tmp_path / "rectified"
    rectified.mkdir()
    meta = {"ok": True, "screen_size": data["screen_size"]}
    (rectified / "raw_upload.ocr.json").write_text(json.dumps(data))
    (rectified / "raw_upload.rectify.json").write_text(json.dumps(meta))
    cv2.imwrite(str(rectified / "raw_upload.png"),
                np.full((data["screen_size"][1], data["screen_size"][0], 3), 255, np.uint8))
    cli("raw_upload", "--rectified-dir", rectified, "--output-dir", tmp_path / "results",
        "--templates-dir", tmp_path / "templates", "--labels", tmp_path / "none",
        "--record-report", tmp_path / "none")
    expected = json.loads((tmp_path / "results/raw_upload.fields.json").read_text())

    class Ocr:
        def ocr(self, *args, **kwargs):
            return [[[line["bbox"]["points"], (line["text"], line["conf"])] for line in data["lines"]]]

    attempts = []
    def rectify(original, target, meta_path, **kwargs):
        attempts.append(kwargs.get("max_size"))
        cv2.imwrite(str(target), np.full((data["screen_size"][1], data["screen_size"][0], 3), 255, np.uint8))
        meta_path.write_text(json.dumps(meta))
        return copy.deepcopy(meta)

    monkeypatch.delenv("HMI_API_KEY", raising=False)
    monkeypatch.setattr(svc, "HERE", tmp_path)
    monkeypatch.setattr(svc, "RECORD_REPORT", tmp_path / "none")
    monkeypatch.setattr(svc, "MACHINE_LABELS", tmp_path / "none")
    monkeypatch.setattr(svc, "is_ready", True)
    monkeypatch.setattr(svc, "concurrency_semaphore", asyncio.Semaphore(1))
    monkeypatch.setattr(svc, "ocr_model", Ocr())
    monkeypatch.setattr(svc, "rectify", rectify)
    monkeypatch.setattr(svc, "assess", lambda *args: QualityReport(filename="offline", triage="green"))
    # OCR and geometry are replayed; extraction and routing execute unchanged.
    monkeypatch.setattr(svc, "classify", lambda *args: {"ui_family": "DEMAG", "page": "injection_metering"})
    _, png = cv2.imencode(".png", np.full((100, 100, 3), 255, np.uint8))
    response = TestClient(svc.app).post("/api/v1/recognize", files={"file": ("offline.png", png.tobytes(), "image/png")})
    assert response.status_code == 200, response.text
    actual = response.json()
    for key in ("status", "warnings", "controller_family", "page_type", "profile_id"):
        assert actual.get(key) == expected.get(key), key
    for key in ("fields", "field_meta"):
        assert actual.get(key, {}) == expected.get(key, {}), key
    if warning:
        assert any(item.startswith(warning) for item in actual["warnings"])
    if case in ("disabled", "conflict", "version", "contract", "bad_id"):
        assert actual["status"] == "reject"
        assert not any(item.startswith("GENERIC_FALLBACK") for item in actual["warnings"])
        assert len(attempts) == 1


@pytest.mark.parametrize("disabled", [False, True])
def test_legacy_page_alias_cannot_bypass_unanchored_registry_policy(tmp_path, monkeypatch, disabled):
    import page_template_registry as registry
    templates = tmp_path / "templates"
    templates.mkdir()
    (tmp_path / "contracts").mkdir()
    entries = []
    for name in ("one", "two"):
        pid = f"demag.injection_metering.{name}"
        template = dict(profile_id=pid, ui_family="DEMAG", page="injection_metering",
                        enabled=not disabled, extractor="registered_extractor", extractor_id="demag")
        (templates / f"{name}.json").write_text(json.dumps(template))
        entries.append(dict(profile_id=pid, template=f"{name}.json"))
    (tmp_path / "contracts/profiles.json").write_text(json.dumps({"profiles": entries}))
    monkeypatch.setattr(registry, "route_page", lambda *args, **kwargs: ("monitor_curve", "find_page"))
    _, source, selected = registry.resolve_page_template("offline", [], "DEMAG", templates)
    assert source == ("disabled_template" if disabled else "ambiguous_template_anchors")
    assert selected is None
