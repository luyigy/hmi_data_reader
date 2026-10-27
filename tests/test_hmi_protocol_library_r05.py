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
    definition = json.loads((ROOT / "contracts/raw-pages/b-and-r-metering-1.0.0.json").read_text())
    independent = [sample for sample in definition["samples"] if sample["purpose"] == "independent_acceptance"]
    assert independent, (
        "R05 missing_business_material: no sample has an explicit independent "
        "acceptance record and complete raw-screen truth. Historical holdout "
        "directory names do not establish independence. The selected metering page "
        "requires distinct development and acceptance originals. "
        "Development and trial may continue; release and A13/A17 remain blocked."
    )
    development_hashes = {sample["image_sha256"] for sample in definition["samples"] if sample["purpose"] == "development"}
    for sample in independent:
        image = ROOT / sample["image"]
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        assert digest == sample["image_sha256"] and digest not in development_hashes
        truth = json.loads((ROOT / sample["truth"]).read_text())
        assert truth["image_sha256"] == digest
        assert truth["provenance"]["independent_of_development_image"] is True
        assert truth["provenance"]["tuning_involvement"] == "none"
        assert set(truth["values"]) == {field["screen_field_key"] for field in definition["fields"]}


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


@pytest.fixture(scope="module")
def metering_live():
    from paddleocr import PaddleOCR
    from scripts.rectify import rectify
    from scripts.raw_page_ocr import engine_identity

    definition = json.loads((ROOT / "contracts/raw-pages/b-and-r-metering-1.0.0.json").read_text())
    directory = Path(tempfile.mkdtemp(prefix="metering-live-", dir=OUTPUT))
    engine = PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False)
    samples, metas = [], {}
    for spec in definition["samples"]:
        name = spec["sample_id"]
        image = ROOT / spec["image"]
        assert hashlib.sha256(image.read_bytes()).hexdigest() == spec["image_sha256"]
        meta = rectify(image, directory / f"{name}.png", directory / f"{name}.rectify.json")
        assert meta["ok"], meta
        raw = engine.ocr(str(directory / f"{name}.png"), cls=False)
        lines = []
        for points, (text, confidence) in raw[0] or []:
            xs, ys = zip(*points)
            lines.append(dict(text=text, conf=float(confidence), bbox=dict(
                x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
        ocr = dict(lines=lines, engine_identity=engine_identity(engine), screen_size=meta["screen_size"])
        (directory / f"{name}.ocr.json").write_text(json.dumps(ocr, ensure_ascii=False, indent=2))
        metas[name] = meta
        samples.append(dict(manifest=dict(sample_id=name, profile_id=definition["profile_id"],
                            original_sha256=spec["image_sha256"], original_size=meta["original_size"],
                            screen_size=meta["screen_size"], original_path=spec["image"], purpose=spec["purpose"]), ocr=ocr))
    template = dict(profile_id=definition["profile_id"], version="1.0.0", page="storage_cooling",
                    ui_family="B_AND_R", route_families=["B_AND_R", "unknown"], layout_variant="three_stage_metering",
                    extractor="registered_extractor", extractor_id="b_and_r.metering", extractor_version="1",
                    layout_anchors=["前抽", "后抽", "模式", "计时器", r"EKS[_ ]?\d+"],
                    family_detect_groups=[["前抽"], ["后抽"], ["熔胶零背压阀"], ["抽胶零背压阀"], ["EKS"]],
                    page_identity={**definition["page_identity"], "evidence_sample_ids": [s["manifest"]["sample_id"] for s in samples]},
                    sample_ids=[s["manifest"]["sample_id"] for s in samples], business_profile_candidate={})
    (directory / "template.json").write_text(json.dumps(template, ensure_ascii=False, indent=2))
    return dict(definition=definition, engine=engine, directory=directory, samples=samples, metas=metas, template=template)


@pytest.fixture
def metering_storage(metering_live, monkeypatch):
    root = Path(tempfile.mkdtemp(prefix="metering-storage-", dir=OUTPUT))
    (root / "contracts").mkdir()
    (root / "templates").mkdir()
    (root / "contracts/profiles.json").write_text('{"profiles": []}')
    monkeypatch.setattr(admin, "ROOT", root)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "r05-isolated")
    app = FastAPI()
    app.include_router(admin.router)
    client = TestClient(app)
    pid = metering_live["definition"]["profile_id"]
    body = dict(expected_version=None, template=metering_live["template"], samples=metering_live["samples"])
    saved = client.put(f"{PREFIX}/drafts/{pid}", json=body, headers={"Authorization": "Bearer r05-isolated"})
    assert saved.status_code == 200, saved.text
    trial = client.post(f"{PREFIX}/drafts/{pid}/trial", json={"expected_revision": 1},
                        headers={"Authorization": "Bearer r05-isolated"})
    assert trial.status_code == 200, trial.text
    published = client.post(f"{PREFIX}/drafts/{pid}/publish", json=dict(expected_revision=1,
                            expected_version=None, confirmation="publish_confirmed"),
                            headers={"Authorization": "Bearer r05-isolated"})
    assert published.status_code == 200, published.text
    return root, client, pid, body


def test_a04_a11_a17_real_metering_values_and_complete_original_contract(metering_storage, metering_live):
    from scripts.raw_metering import observe_metering_page
    from scripts.raw_contract import validate_raw_record

    root, client, pid, _ = metering_storage
    package = client.get(f"{PREFIX}/{pid}/package", params={"version": "1.0.0"}).json()
    import_raw_package(package)
    for spec, sample in zip(metering_live["definition"]["samples"], metering_live["samples"]):
        name = spec["sample_id"]
        observation = observe_metering_page(sample["ocr"]["lines"], metering_live["metas"][name],
                                           spec["image_sha256"], root)
        observation["engine"] = sample["ocr"]["engine_identity"]
        validate_raw_record(observation, package)
        assert package["raw_contract"]["properties"]["schema_version"]["const"] == observation["schema_version"]
        truth = json.loads((ROOT / spec["truth"]).read_text())["values"]
        assert len(observation["fields"]) == len(truth) == 38
        for field in observation["fields"]:
            key = field["screen_field_key"]
            assert field["state"] == "unknown"
            if key.startswith(("storage.", "decompression.", "control.")):
                assert field["original_value"] == truth[key], (name, key, field)
            elif field["original_value"] != truth[key]:
                assert field["reading"] in ("missing", "conflict", "uncertain"), (name, key, field)
            if field["reading"] == "known":
                assert field["original_value"] == truth[key], (name, key, field)
            if field["original_value"] is not None:
                assert field["bbox"] and field["original_bbox"], (name, field)
        assert observation["coverage"]["status"] == "partial"
        (metering_live["directory"] / f"{name}.v2.json").write_text(json.dumps(observation, ensure_ascii=False, indent=2))


def test_a13_a14_raw_package_get_reopen_offline_and_immutable_sources(metering_storage):
    from scripts.raw_contract import canonical_hash

    root, client, pid, _ = metering_storage
    response = client.get(f"{PREFIX}/{pid}/package", params={"version": "1.0.0"})
    assert response.status_code == 200, response.text
    package = response.json()
    assert package["package_schema"] == "hmi_raw_page_package.v2"
    assert package["recognizer"]["id"] == "b_and_r.metering.v2"
    for path, source in package["recognizer"]["sources"].items():
        assert hashlib.sha256(source.encode()).hexdigest() == package["recognizer"]["files"][path]
    before = (root / "templates/packages" / pid / "1.0.0.json").read_bytes()
    app = FastAPI()
    app.include_router(admin.router)
    with TestClient(app) as reopened:
        assert reopened.get(f"{PREFIX}/{pid}/package", params={"version": "1.0.0"}).json() == package
    assert (root / "templates/packages" / pid / "1.0.0.json").read_bytes() == before
    exported = import_raw_package(json.loads(json.dumps(package)))
    assert exported["raw_field_definition_sha256"] == canonical_hash(exported["raw_field_definition"])
    (OUTPUT / "metering-exported-package.json").write_text(json.dumps(package, ensure_ascii=False, indent=2))


def test_a14_publish_failure_disable_upgrade_and_rollback_preserve_old_packages(metering_storage, monkeypatch):
    import copy
    import page_template_lifecycle as lifecycle
    from scripts.export_page_package import export_page_package

    root, client, pid, body = metering_storage
    headers = {"Authorization": "Bearer r05-isolated"}
    old = export_page_package(pid, "1.0.0", root)
    snapshot = (root / "contracts/profiles.json").read_bytes()
    request = copy.deepcopy(body)
    request.update(expected_version="1.0.0", expected_revision=1)
    request["template"].update(version="1.0.1", enabled=False)
    assert client.put(f"{PREFIX}/drafts/{pid}", json=request, headers=headers).status_code == 200
    real_write = lifecycle.atomic_json

    def fail_activity(path, value):
        if path == root / "contracts/profiles.json":
            raise OSError("R05 actual publication-failure injection")
        return real_write(path, value)

    with monkeypatch.context() as scoped:
        scoped.setattr(lifecycle, "atomic_json", fail_activity)
        failed = client.post(f"{PREFIX}/drafts/{pid}/publish", json=dict(expected_revision=2,
                             expected_version="1.0.0", confirmation="publish_confirmed"), headers=headers)
        assert failed.status_code == 503, failed.text
    assert (root / "contracts/profiles.json").read_bytes() == snapshot
    disabled = client.post(f"{PREFIX}/drafts/{pid}/publish", json=dict(expected_revision=2,
                           expected_version="1.0.0", confirmation="publish_confirmed"), headers=headers)
    assert disabled.status_code == 200, disabled.text
    assert client.get(f"{PREFIX}/{pid}").json()["template"]["enabled"] is False
    assert export_page_package(pid, "1.0.0", root) == old
    request.update(expected_version="1.0.1", expected_revision=2)
    request["template"] = {**old["template"], "version": "1.0.2", "enabled": True}
    assert client.put(f"{PREFIX}/drafts/{pid}", json=request, headers=headers).status_code == 200
    rolled_back = client.post(f"{PREFIX}/drafts/{pid}/publish", json=dict(expected_revision=3,
                              expected_version="1.0.1", confirmation="publish_confirmed"), headers=headers)
    assert rolled_back.status_code == 200, rolled_back.text
    assert client.get(f"{PREFIX}/{pid}").json()["template"]["version"] == "1.0.2"
    assert export_page_package(pid, "1.0.0", root) == old
    assert export_page_package(pid, "1.0.1", root)["template"]["enabled"] is False
    assert export_page_package(pid, "1.0.2", root)["raw_field_definition"]["fields"] == old["raw_field_definition"]["fields"]
    (OUTPUT / "metering-lifecycle.json").write_text(json.dumps(dict(failed=failed.json(), disabled=disabled.json(),
        rollback=rolled_back.json(), versions=client.get(f"{PREFIX}/{pid}/versions").json()), ensure_ascii=False, indent=2))


def test_a07_a13_cli_binding_unknown_conflict_hash_and_disabled(metering_storage, metering_live):
    import copy
    import subprocess
    import sys
    from scripts.raw_contract import canonical_hash
    from scripts.extract_fields import extract_one

    root, client, pid, _ = metering_storage
    package = client.get(f"{PREFIX}/{pid}/package", params={"version": "1.0.0"}).json()
    hint = dict(brand="BOLE", controller_family="B_AND_R", interface_generation=None,
                binding_revision=1, pages=[dict(profile_id=pid, version="1.0.0", package_sha256=canonical_hash(package))])
    directory = metering_live["directory"]
    (root / "hint.json").write_text(json.dumps(hint))
    command = [sys.executable, "scripts/extract_fields.py", "independent", "--rectified-dir", str(directory),
               "--output-dir", str(root / "cli"), "--templates-dir", str(root / "templates"),
               "--record-report", str(root / "absent"), "--labels", str(root / "absent"),
               "--controller-hint", str(root / "hint.json"), "--observations-version", "v2",
               "--original-image", str(ROOT / "datasets/r05/b_and_r.metering.three_stage/independent.jpg")]
    process = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=90)
    assert process.returncode == 0, process.stdout + process.stderr
    result = json.loads((root / "cli/independent.fields.json").read_text())
    assert result["compatibility"]["code"] == "PAGE_COMPATIBLE", result
    assert result["page_observations"]["schema_version"] == "page_observations.v2"
    assert len(result["page_observations"]["fields"]) == 38
    for change, code in [(dict(controller_family="EST"), "PAGE_BINDING_MISMATCH"),
                         (dict(pages=[{**hint["pages"][0], "version": "99.0.0"}]), "PAGE_PACKAGE_INCOMPATIBLE"),
                         (dict(pages=[{**hint["pages"][0], "package_sha256": "0" * 64}]), "PAGE_PACKAGE_INCOMPATIBLE")]:
        broken = {**copy.deepcopy(hint), **change}
        rejected = extract_one("independent", directory, {}, {}, root / "templates", controller_hint=broken)
        assert rejected["compatibility"]["code"] == code
        assert not rejected.get("fields") and not any("GENERIC_FALLBACK" in w for w in rejected["warnings"])
    unknown = root / "unknown"
    unknown.mkdir()
    (unknown / "independent.rectify.json").write_bytes((directory / "independent.rectify.json").read_bytes())
    (unknown / "independent.ocr.json").write_text(json.dumps(dict(lines=[dict(text="unknown panel", conf=.99,
        bbox=dict(x_min=1, y_min=1, x_max=10, y_max=10))])))
    rejected = extract_one("independent", unknown, {}, {}, root / "templates", controller_hint=hint)
    assert rejected["compatibility"]["code"] == "PAGE_UNKNOWN"
    registry_path = root / "contracts/profiles.json"
    registry_bytes = registry_path.read_bytes()
    ambiguous = json.loads(registry_bytes)
    other = {**package["template"], "profile_id": "b_and_r.metering.ambiguous"}
    (root / "templates/ambiguous.json").write_text(json.dumps(other))
    ambiguous["profiles"].append(dict(profile_id=other["profile_id"], template="ambiguous.json"))
    registry_path.write_text(json.dumps(ambiguous))
    rejected = extract_one("independent", directory, {}, {}, root / "templates", controller_hint=hint)
    assert rejected["compatibility"]["code"] == "PAGE_TEMPLATE_CONFLICT"
    assert not rejected.get("fields") and not any("GENERIC_FALLBACK" in w for w in rejected["warnings"])
    registry_path.write_bytes(registry_bytes)
    (root / "templates/ambiguous.json").unlink()
    draft = client.get(f"{PREFIX}/drafts/{pid}", headers={"Authorization": "Bearer r05-isolated"}).json()
    template = {**draft["template"], "version": "1.0.1", "enabled": False}
    saved = client.put(f"{PREFIX}/drafts/{pid}", json=dict(expected_version="1.0.0", expected_revision=1,
                       template=template, samples=draft["samples"]), headers={"Authorization": "Bearer r05-isolated"})
    assert saved.status_code == 200, saved.text
    disabled = client.post(f"{PREFIX}/drafts/{pid}/publish", json=dict(expected_version="1.0.0",
                           expected_revision=2, confirmation="publish_confirmed"), headers={"Authorization": "Bearer r05-isolated"})
    assert disabled.status_code == 200, disabled.text
    rejected = extract_one("independent", directory, {}, {}, root / "templates", controller_hint=hint)
    assert rejected["compatibility"]["code"] == "PAGE_TEMPLATE_DISABLED"
    assert not rejected.get("fields") and not any("GENERIC_FALLBACK" in w for w in rejected["warnings"])
    (OUTPUT / "metering-cli-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))


def test_a13_real_http_upload_emits_frozen_original_screen(metering_storage, metering_live, monkeypatch):
    import asyncio
    import httpx
    import hmi_service as service
    from scripts.raw_contract import canonical_hash, validate_raw_record

    root, client, pid, _ = metering_storage
    package = client.get(f"{PREFIX}/{pid}/package", params={"version": "1.0.0"}).json()
    hint = dict(brand="BOLE", controller_family="B_AND_R", interface_generation=None, binding_revision=1,
                pages=[dict(profile_id=pid, version="1.0.0", package_sha256=canonical_hash(package))])
    monkeypatch.setattr(service, "HERE", root)
    monkeypatch.setattr(service, "ocr_model", metering_live["engine"])
    monkeypatch.setattr(service, "is_ready", True)
    monkeypatch.setattr(service, "concurrency_semaphore", asyncio.Semaphore(1))
    monkeypatch.delenv("HMI_API_KEY", raising=False)
    spec = next(s for s in metering_live["definition"]["samples"] if s["sample_id"] == "independent")
    content = (ROOT / spec["image"]).read_bytes()

    async def upload():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://reader") as session:
            return await session.post("/api/v1/recognize", params=dict(observations_version="v2", controller_hint=json.dumps(hint)),
                                      files={"file": ("independent.jpg", content, "image/jpeg")})

    response = asyncio.run(upload())
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["compatibility"]["code"] == "PAGE_COMPATIBLE", result
    observation = result["page_observations"]
    validate_raw_record(observation, package)
    assert observation["image_sha256"] == hashlib.sha256(content).hexdigest()
    assert any(field["confidence"] and field["confidence"] > .9 for field in observation["fields"])
    truth = json.loads((ROOT / spec["truth"]).read_text())["values"]
    for field in observation["fields"]:
        if field["screen_field_key"].startswith(("storage.", "decompression.")):
            assert field["original_value"] == truth[field["screen_field_key"]], field
        if field["reading"] == "known":
            assert field["original_value"] == truth[field["screen_field_key"]], field
    (OUTPUT / "metering-http-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))

    async def ordinary_upload():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://reader") as session:
            return await session.post("/api/v1/recognize", params={"observations_version": "v2"},
                                      files={"file": ("independent.jpg", content, "image/jpeg")})

    ordinary = asyncio.run(ordinary_upload())
    assert ordinary.status_code == 200, ordinary.text
    assert ordinary.json()["profile_id"] == pid
    assert ordinary.json()["page_observations"]["raw_field_definition_sha256"] == package["raw_field_definition_sha256"]
    (OUTPUT / "metering-ordinary-http-result.json").write_text(json.dumps(ordinary.json(), ensure_ascii=False, indent=2))


def test_a04_a11_metering_reversed_duplicate_missing_and_low_confidence(metering_live):
    import copy
    from scripts.extract_families.b_and_r_metering import extract_metering

    sample = metering_live["samples"][0]
    lines = copy.deepcopy(sample["ocr"]["lines"])
    third = next(line for line in lines if line["text"] == "3")
    speed = sorted([line for line in lines if line["text"] == "25.0"], key=lambda line: line["bbox"]["x_min"])
    for stage, cell in zip([1, 2], speed):
        header = copy.deepcopy(third)
        header["text"] = str(stage)
        header["bbox"]["x_min"] = cell["bbox"]["x_min"]
        header["bbox"]["x_max"] = cell["bbox"]["x_max"]
        lines.append(header)
    # Deliberate OCR mutations test structure; these are not new photograph evidence.
    first = next(line for line in lines if line["text"] == "1")
    first["text"], third["text"] = "3", "1"
    result = extract_metering(lines, metering_live["template"], metering_live["metas"]["development"])
    fields = {f["screen_field_key"]: f for f in result["detail"]["page_observations"]["fields"]}
    assert fields["storage.end_position.stage-1"]["original_value"] == 110
    assert fields["storage.end_position.stage-1"]["order"] == 3
    assert fields["storage.end_position.stage-3"]["original_value"] == 40
    assert fields["storage.end_position.stage-3"]["order"] == 1
    third["text"] = "3"
    rejected = extract_metering(lines, metering_live["template"], metering_live["metas"]["development"])
    assert rejected["warnings"] == ["STAGE_IDENTITY_CONFLICT"] and not rejected["detail"]
    lines = copy.deepcopy(sample["ocr"]["lines"])
    pressure = sorted([line for line in lines if line["text"] == "65.0"], key=lambda line: line["bbox"]["x_min"])[0]
    pressure["conf"] = .2
    result = extract_metering(lines, metering_live["template"], metering_live["metas"]["development"])
    field = next(f for f in result["detail"]["page_observations"]["fields"] if f["screen_field_key"] == "storage.pressure.stage-1")
    assert field["original_value"] == 65 and field["reading"] == "uncertain" and field["state"] == "unknown"
    lines.append(copy.deepcopy(pressure))
    result = extract_metering(lines, metering_live["template"], metering_live["metas"]["development"])
    assert any(issue["code"] == "STORAGE_ROW_CARDINALITY_CONFLICT" for issue in result["detail"]["page_observations"]["issues"])
    assert all(f["state"] == "unknown" for f in result["detail"]["page_observations"]["fields"])


def test_a14_old_raw_record_replay_and_offline_manual_fields(metering_storage, metering_live):
    from scripts.raw_contract import validate_raw_record
    from scripts.raw_metering import observe_metering_page, metering_package

    root, client, pid, _ = metering_storage
    package = metering_package(root)
    sample = metering_live["samples"][0]
    record = observe_metering_page(sample["ocr"]["lines"], metering_live["metas"]["development"],
                                  sample["manifest"]["original_sha256"], root)
    record["engine"] = sample["ocr"]["engine_identity"]
    assert validate_raw_record(json.loads(json.dumps(record)), package) == record
    spec = package["raw_field_definition"]["fields"][12]
    manual = dict(schema_version="page_observations.v2", profile_id=pid, source="manual", actor="offline-reviewer",
                  created_at="2026-10-20T08:00:00Z", revision=1, raw_field_definition_sha256=package["raw_field_definition_sha256"],
                  fields=[dict(screen_field_key=spec["screen_field_key"], source="manual", original_label=spec["label"],
                               original_value=25, original_unit="%", role="setting", state="unknown", reading="known", original_bbox=None)])
    assert validate_raw_record(manual, package) == manual
    path = root / "templates/packages" / pid / "1.0.0.json"
    damaged = json.loads(path.read_text())
    damaged["recognizer"]["sources"]["scripts/raw_metering.py"] += "\n# tampered\n"
    path.write_text(json.dumps(damaged))
    with pytest.raises(ValueError, match="RAW_RECOGNIZER_HASH_MISMATCH"):
        metering_package(root)
