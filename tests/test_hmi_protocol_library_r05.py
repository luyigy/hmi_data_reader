"""R05 real candidate OCR/trial and release prerequisites, separately reported."""

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
    definition = json.loads((ROOT / "contracts/raw-pages/est-storage-white-0.5.0-draft.json").read_text())
    independent = definition["independent_acceptance"]
    assert independent, (
        "R05 missing_business_material: no sample has an explicit independent "
        "acceptance record and complete raw-screen truth. Historical holdout "
        "directory names do not establish independence. The BOLE white five-stage "
        "storage/decompression candidate has one development photo only. "
        "Development and trial may continue; release and A13/A17 remain blocked."
    )
    development_hashes = {sample["image_sha256"] for sample in definition["samples"]}
    for sample in independent:
        image = ROOT / sample["image"]
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        assert digest == sample["image_sha256"] and digest not in development_hashes
        truth = json.loads((ROOT / sample["truth"]).read_text())
        assert truth["image_sha256"] == digest
        assert truth["provenance"]["independent_acceptance"] is True
        assert truth["provenance"]["tuning_involvement"] == "none"
        assert truth["provenance"]["complete_raw_screen_truth"] is True


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


@pytest.fixture(scope="module")
def white_live():
    from paddleocr import PaddleOCR
    from scripts.rectify import rectify

    definition = json.loads((ROOT / "contracts/raw-pages/est-storage-white-0.5.0-draft.json").read_text())
    image = ROOT / definition["samples"][0]["image"]
    assert hashlib.sha256(image.read_bytes()).hexdigest() == definition["samples"][0]["image_sha256"]
    OUTPUT.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="white-live-", dir=OUTPUT))
    meta = rectify(image, directory / "white.png", directory / "white.rectify.json")
    assert meta["ok"], meta
    engine = PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False)
    raw = engine.ocr(str(directory / "white.png"), cls=False)
    lines = []
    for points, (text, confidence) in raw[0] or []:
        xs, ys = zip(*points)
        lines.append(dict(text=text, conf=float(confidence), bbox=dict(
            x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
    assert lines
    ocr = dict(lines=lines, engine="paddleocr", version="2.7.3", device="cpu")
    (directory / "white.ocr.json").write_text(json.dumps(ocr, ensure_ascii=False, indent=2))
    template = dict(profile_id=definition["profile_id"], version="0.5.0",
                    page="storage_cooling", ui_family="EST", layout_variant="white_five_stage",
                    extractor="registered_extractor", extractor_id=definition["extractor_id"],
                    sample_ids=["white-development"], layout_anchors=["储料射退设定", "五段"],
                    business_profile_candidate={})
    return definition, template, meta, ocr, directory


def test_a04_a11_white_real_ocr_preserves_values_missing_and_unknown(white_live):
    from scripts.extractor_registry import extract_registered

    definition, template, meta, ocr, directory = white_live
    result = extract_registered([], template, ocr_lines=ocr["lines"], meta=meta)
    observed = result["detail"]["page_observations"]
    (directory / "white.observations.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    truth = json.loads((ROOT / definition["samples"][0]["truth"]).read_text())["values"]
    assert len(observed["fields"]) == len(truth) == 44
    assert {field["screen_field_key"]: field["original_value"] for field in observed["fields"]} == truth
    assert observed["coverage"]["status"] == "partial"
    assert observed["publication_state"] == "development_only"
    assert result["fields"] is None
    for field in observed["fields"]:
        assert field["state"] == "unknown"
        if field["original_value"] is not None:
            assert field["original_bbox"] and field["bbox"]
        if field.get("stage") in (3, 4, 5):
            assert field["original_value"] is None and field["reading"] == "missing"
    by_key = {field["screen_field_key"]: field for field in observed["fields"]}
    assert by_key["storage.speed.stage-1"]["original_unit"] == "%"
    assert by_key["storage.pressure.stage-1"]["original_unit"] == "bar"
    assert by_key["footer.injection_pressure.control"]["reading"] == "unsupported"
    assert by_key["header.unresolved-column-1-row-1"]["role"] == "unknown"


def test_a04_white_observations_follow_ocr_and_reject_conflicts(white_live):
    import copy
    from scripts.extractor_registry import extract_registered

    _, template, meta, ocr, _ = white_live
    lines = copy.deepcopy(ocr["lines"])
    pressure = next(line for line in lines if line["text"] == "120.0")
    pressure["text"] = "119.0"
    pressure["conf"] = .4
    result = extract_registered([], template, ocr_lines=lines, meta=meta)
    first = result["detail"]["page_observations"]["fields"][0]
    assert first["original_value"] == 119 and first["reading"] == "uncertain"
    lines.append(copy.deepcopy(pressure))
    result = extract_registered([], template, ocr_lines=lines, meta=meta)
    first = result["detail"]["page_observations"]["fields"][0]
    assert first["original_value"] is None and first["reading"] == "conflict"
    lines = [line for line in ocr["lines"] if line["text"] != "五段"]
    result = extract_registered([], template, ocr_lines=lines, meta=meta)
    assert result["detail"] == {} and result["warnings"] == ["EST_WHITE_LAYOUT_MISMATCH"]
    lines = copy.deepcopy(ocr["lines"])
    next(line for line in lines if line["text"] == "一段")["text"] = "二段"
    result = extract_registered([], template, ocr_lines=lines, meta=meta)
    assert not result["detail"]
    lines = copy.deepcopy(ocr["lines"])
    next(line for line in lines if line["text"] == "120.0")["text"] = "120.0mm"
    result = extract_registered([], template, ocr_lines=lines, meta=meta)
    first = result["detail"]["page_observations"]["fields"][0]
    assert first["original_value"] == 120 and first["original_unit"] == "mm"
    assert first["reading"] == "conflict" and "unit_template_conflict" in first["reasons"]


def test_a13_white_http_draft_trial_and_reopen_without_publication(white_live, monkeypatch):
    definition, template, meta, ocr, directory = white_live
    root = Path(tempfile.mkdtemp(prefix="white-draft-", dir=OUTPUT))
    (root / "contracts").mkdir()
    (root / "contracts/profiles.json").write_text('{"profiles": []}')
    monkeypatch.setattr(admin, "ROOT", root)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "r05-isolated")
    app = FastAPI()
    app.include_router(admin.router)
    profile = definition["profile_id"]
    sample = dict(manifest=dict(sample_id="white-development", profile_id=profile,
                               original_sha256=meta["original_sha256"], original_size=meta["original_size"],
                               screen_size=meta["screen_size"], purpose="development"), ocr=ocr)
    with TestClient(app) as client:
        saved = client.put(f"{PREFIX}/drafts/{profile}", json=dict(expected_version=None,
                           template=template, samples=[sample]),
                           headers={"Authorization": "Bearer r05-isolated"})
        assert saved.status_code == 200, saved.text
        trial = client.post(f"{PREFIX}/drafts/{profile}/trial", json={"expected_revision": 1},
                            headers={"Authorization": "Bearer r05-isolated"})
        assert trial.status_code == 200, trial.text
        fields = trial.json()["after"][0]["result"]["detail"]["page_observations"]["fields"]
        assert fields[0]["original_value"] == 120
        assert all(field["original_bbox"] is None for field in fields)
        published = client.post(f"{PREFIX}/drafts/{profile}/publish",
                                json=dict(expected_revision=1, expected_version=None, confirmation="publish_confirmed"),
                                headers={"Authorization": "Bearer r05-isolated"})
        assert published.status_code == 422, published.text
        assert "EXTRACTOR_DEVELOPMENT_ONLY" in published.text
    with TestClient(app) as reopened:
        response = reopened.get(f"{PREFIX}/drafts/{profile}",
                                headers={"Authorization": "Bearer r05-isolated"})
        assert response.status_code == 200, response.text
        assert response.json() == saved.json()
    assert json.loads((root / "contracts/profiles.json").read_text()) == {"profiles": []}
    assert not (root / "templates/packages").exists()
    (directory / "white.http-trial.json").write_text(json.dumps(trial.json(), ensure_ascii=False, indent=2))
    (directory / "white.http-reopen.json").write_text(json.dumps(response.json(), ensure_ascii=False, indent=2))
