"""R05 material prerequisite and existing safety behavior, not release acceptance.

The positive new-layout OCR/publication scenario requires a frozen, complete
reference and independent photos. Until supplied, the material gate must fail.
"""

import hashlib
import json
import os
from pathlib import Path
import tempfile

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import yaml

import page_template_admin as admin
from scripts.raw_contract import import_raw_package

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ["AP_GRAPH_OUTPUT_DIR"])
PREFIX = "/api/v1/page-templates"


@pytest.fixture(scope="module")
def materials():
    manifest = json.loads((ROOT / "datasets/release_manifest.json").read_text())
    rows = []
    for partition, entries in manifest["partitions"].items():
        for entry in entries:
            truth_path = ROOT / "datasets" / entry["path"]
            truth = yaml.safe_load(truth_path.read_text())
            image = truth_path.parent / truth["image"]["file"]
            rows.append({"profile_id": entry["profile_id"], "partition": partition,
                         "image": str(image.relative_to(ROOT)),
                         "image_sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
                         "declared_sha256": entry["image_sha256"].removeprefix("sha256:"),
                         "truth": str(truth_path.relative_to(ROOT)),
                         "truth_sha256": hashlib.sha256(truth_path.read_bytes()).hexdigest(),
                         "provenance": truth.get("provenance", {}),
                         "fields": sorted(truth["fields"])})
    images = [{"image": str(p.relative_to(ROOT)),
               "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
              for directory in ("datasets", "ground_truth")
              for p in sorted((ROOT / directory).rglob("*"))
              if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}]
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "r05-material-inventory.json").write_text(json.dumps(
        {"images": images, "manifest_samples": rows,
         "unique_image_hashes": len({row["sha256"] for row in images})},
        ensure_ascii=False, indent=2))
    return rows


def test_a17_originals_match_the_frozen_manifest(materials):
    assert materials, "No actual sample material is available"
    assert all(row["image_sha256"] == row["declared_sha256"] for row in materials)


def test_a13_a17_independent_new_layout_material_is_available(materials):
    independent = [row for row in materials
                   if row["provenance"].get("independent_acceptance") is True
                   and row["provenance"].get("tuning_involvement") == "none"
                   and row["provenance"].get("complete_raw_screen_truth") is True]
    assert independent, (
        "R05 missing_business_material: no sample has an explicit independent "
        "acceptance record and complete raw-screen truth. Historical holdout "
        "directory names do not establish independence. See r05-material-inventory.json; "
        "HOT_SYSTEM has only three exposed calibration samples with SV-only truth. "
        "Do not start adapter development or claim A13/A17 acceptance."
    )


@pytest.mark.parametrize("injection,reason", [
    ({"extractor_id": "os.system"}, "EXTRACTOR_ID_UNREGISTERED"),
    ({"extractor_id": "../../evil"}, "EXTRACTOR_ID_UNREGISTERED"),
    ({"module": "os"}, "Import paths are not template configuration"),
    ({"import_path": "os.system"}, "Import paths are not template configuration"),
])
def test_a13_http_rejects_arbitrary_import_without_writes(injection, reason, monkeypatch):
    root = Path(tempfile.mkdtemp(prefix="r05-denied-", dir=OUTPUT))
    monkeypatch.setattr(admin, "ROOT", root)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "r05-isolated")
    app = FastAPI()
    app.include_router(admin.router)
    template = {"profile_id": "r05.material.audit", "version": "1.0.0",
                "extractor": "registered_extractor", "extractor_id": "demag",
                "page": "injection_metering", **injection}
    with TestClient(app) as client:
        response = client.put(f"{PREFIX}/drafts/r05.material.audit",
                              json={"expected_version": None, "template": template, "samples": []},
                              headers={"Authorization": "Bearer r05-isolated"})
    assert response.status_code == 422, response.text
    assert reason in response.json()["detail"]
    assert list(root.rglob("*")) == [], "Denied draft wrote persistent data"


@pytest.mark.parametrize("profile", ["demag.temperature.screen_order_5",
                                    "est.storage_cooling.cooling_delay"])
def test_a14_existing_frozen_packages_survive_independent_http_readback(profile, monkeypatch):
    monkeypatch.setattr(admin, "ROOT", ROOT)
    app = FastAPI()
    app.include_router(admin.router)
    frozen = ROOT / "templates/raw-packages" / profile / "0.4.1.json"
    before = frozen.read_bytes()
    expected = import_raw_package(json.loads(before))
    for _ in range(2):
        with TestClient(app) as reopened:
            response = reopened.get(f"{PREFIX}/{profile}/package", params={"version": "0.4.1"})
        assert response.status_code == 200, response.text
        assert import_raw_package(response.json()) == expected
    assert frozen.read_bytes() == before
