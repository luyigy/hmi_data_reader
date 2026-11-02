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
    assert catalog["generic_fallback"] == {"enabled": False, "automatic_apply": False}
    for entry in catalog["extractors"]:
        module, name, kind, image, pages = _EXTRACTORS[entry["extractor_id"]]
        assert callable(getattr(importlib.import_module("scripts.extract_families." + module), name))
        assert (entry["input"], entry["image_support"], entry["pages"]) == (kind, image, list(pages))
    monkeypatch.setenv("HMI_API_KEY", "r02-offline")
    assert client.get("/api/v1/capabilities").status_code == 401
    assert client.get("/api/v1/capabilities", headers={"Authorization": "Bearer r02-offline"}).json() == catalog






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
    template = dict(extractor="registered_extractor", extractor_id="b_and_r.injection_metering", page="injection_metering")
    result = extract_page_fields([], {**template, **change})
    assert result["fields"] is None
    assert result["warnings"] == [warning]
