"""R6 NISSEI real OCR, multipart API, CLI and frozen raw-package behavior."""

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

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from raw_contract import canonical_hash, import_raw_package, validate_raw_record
from raw_tact5 import PROFILE, VERSION, tact5_package, observe_tact5_page

OUTPUT = Path(os.environ["AP_GRAPH_OUTPUT_DIR"])
SAMPLE = ROOT / "datasets/r6_nissei" / PROFILE / "development/Z078_20260910_shebao.jpg"


def save(name, document):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / (name + ".json")).write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")


def by_key(record):
    return {field["screen_field_key"]: field for field in record["fields"]}


def hint(package):
    return dict(brand="NISSEI", controller_family="TACT5", interface_generation=None,
                binding_revision=1, pages=[dict(profile_id=PROFILE, version=VERSION,
                package_sha256=canonical_hash(package))])


@pytest.fixture(scope="module")
def live():
    import cv2
    from paddleocr import PaddleOCR
    from raw_page_ocr import engine_identity
    from rectify import rectify

    directory = Path(tempfile.mkdtemp(prefix="r6-live-", dir=OUTPUT))
    digest = hashlib.sha256(SAMPLE.read_bytes()).hexdigest()
    assert digest == "3f0cd45905b1b33b2f837b19f23003c26a563976bdde02988ef6ea4ddc18dc9d"
    meta = rectify(SAMPLE, directory / "sample.png", directory / "sample.rectify.json")
    assert meta["ok"] and meta["original_sha256"] == digest
    engine = PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False)
    lines = []
    for points, (text, confidence) in engine.ocr(str(directory / "sample.png"), cls=False)[0] or []:
        xs, ys = zip(*points)
        lines.append(dict(text=text, conf=float(confidence), bbox=dict(
            x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
    assert lines
    ocr = dict(lines=lines, engine_identity=engine_identity(engine))
    (directory / "sample.ocr.json").write_text(json.dumps(ocr, ensure_ascii=False))
    gray = cv2.imread(str(directory / "sample.png"), cv2.IMREAD_GRAYSCALE)
    record = observe_tact5_page(lines, meta, digest, gray)
    save("r6-live-ocr", ocr)
    save("r6-live-rectify", meta)
    save("r6-live-observations", record)
    return dict(directory=directory, engine=engine, lines=lines, gray=gray, meta=meta,
                digest=digest, record=record)


def upload(live, root, binding=None, version="v2", sample=SAMPLE):
    import httpx
    import hmi_service as service

    async def run():
        service.HERE = root
        service.ocr_model, service.is_ready = live["engine"], True
        service.concurrency_semaphore = asyncio.Semaphore(1)
        params = dict(observations_version=version)
        if binding is not None:
            params["controller_hint"] = json.dumps(binding)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://reader") as client:
            return await client.post("/api/v1/recognize", params=params,
                                     files={"file": (sample.name, sample.read_bytes(), "image/jpeg")})
    previous = service.HERE, service.ocr_model, service.is_ready, service.concurrency_semaphore
    try:
        return asyncio.run(run())
    finally:
        service.HERE, service.ocr_model, service.is_ready, service.concurrency_semaphore = previous


def test_a04_real_disabled_unknown_actual_and_uncertain(live):
    fields = by_key(live["record"])
    disabled = fields["holding.pressure.3"]
    assert (disabled["original_value"], disabled["state"], disabled["reading"]) == (90, "disabled", "known")
    assert disabled["original_unit"] == "MPa" and disabled["original_bbox"] and disabled["bbox"]
    assert fields["holding.time.2"]["original_value"] == .5
    assert fields["holding.time.2"]["state"] == "disabled"
    assert fields["plasticizing.speed.1"]["state"] == "unknown"
    assert fields["screw.position.actual"]["role"] == "actual"
    assert fields["screw.position.actual"]["original_value"] == 40
    assert fields["injection.speed.4"]["reading"] == "uncertain"
    assert fields["injection.speed.4"]["original_value"] == 35
    assert fields["holding.ramp.1"]["reading"] == "unsupported"
    assert live["record"]["coverage"]["status"] == "partial"
    validate_raw_record(live["record"], tact5_package())


def test_a04_removed_ocr_value_stays_missing_without_default(live):
    box = by_key(live["record"])["metering.end"]["bbox"]
    lines = [line for line in live["lines"] if list(line["bbox"].values()) != box]
    assert len(lines) < len(live["lines"])
    record = observe_tact5_page(lines, live["meta"], live["digest"], live["gray"])
    field = by_key(record)["metering.end"]
    assert field["original_value"] is None and field["reading"] == "missing"
    assert field["state"] == "unknown" and field["original_bbox"] is None


def test_a11_reverse_order_and_duplicate_stage_preserves_conflict(live):
    fields = by_key(live["record"])
    assert [fields[f"injection.speed.{stage}"]["order"] for stage in range(1, 7)] == [6, 5, 4, 3, 2, 1]
    assert [fields[f"injection.speed.{stage}"]["stage"] for stage in range(1, 7)] == list(range(1, 7))
    first = next(line for line in live["lines"] if line["text"] == "V1")
    duplicated = observe_tact5_page(live["lines"] + [copy.deepcopy(first)], live["meta"], live["digest"], live["gray"])
    conflict = by_key(duplicated)["injection.speed.1"]
    assert conflict["reading"] == "conflict" and conflict["original_value"] is None
    assert len(conflict["candidates"]) == 2
    assert any(issue["code"] == "FIELD_CONFLICT" for issue in duplicated["issues"])
    save("r6-controlled-duplicate-ocr", duplicated)


def test_real_http_cli_and_distinct_timing(live):
    response = upload(live, ROOT, hint(tact5_package()))
    save("r6-http-response", response.json())
    assert response.status_code == 200, response.text
    http = response.json()
    assert http["compatibility"]["status"] == "compatible"
    assert http["compatibility"]["package_sha256"] == canonical_hash(tact5_package())
    params = [sys.executable, "scripts/extract_fields.py", "sample", "--rectified-dir", str(live["directory"]),
              "--output-dir", str(live["directory"] / "extracted"), "--observations-version", "v2",
              "--original-image", str(SAMPLE)]
    process = subprocess.run(params, cwd=ROOT, capture_output=True, text=True, timeout=180)
    (OUTPUT / "r6-cli.log").write_text(process.stdout + process.stderr)
    assert process.returncode == 0, process.stdout + process.stderr
    cli = json.loads((live["directory"] / "extracted/sample.fields.json").read_text())
    save("r6-cli-response", cli)
    for surface in (http, cli):
        record = surface["page_observations"]
        assert record["image_sha256"] == live["digest"]
        validate_raw_record(record, tact5_package())
        fields = by_key(record)
        for key, value in [("total.injection.time", 3.5), ("cooling.time", 7),
                           ("intermediate.time", .5), ("holding.time.1", 2),
                           ("plasticizing.speed.1", 165), ("metering.end", 30)]:
            assert fields[key]["original_value"] == value
            assert fields[key]["original_bbox"]
        assert fields["intermediate.time"]["time_kind"] != fields["cooling.time"]["time_kind"]


def test_a07_bound_page_failures_do_not_fallback(live):
    from controller_binding import select_bound_page

    root = Path(tempfile.mkdtemp(prefix="r6-binding-", dir=OUTPUT))
    shutil.copytree(ROOT / "templates", root / "templates")
    shutil.copytree(ROOT / "contracts", root / "contracts")
    shutil.copytree(ROOT / "datasets/r6_nissei", root / "datasets/r6_nissei")
    binding = hint(tact5_package(root))
    wrong = copy.deepcopy(binding)
    wrong["controller_family"] = "TACT"
    incompatible = copy.deepcopy(binding)
    incompatible["pages"][0]["package_sha256"] = "0" * 64
    for case, expected in [(wrong, "PAGE_BINDING_MISMATCH"), (incompatible, "PAGE_PACKAGE_INCOMPATIBLE")]:
        response = upload(live, root, case)
        assert response.status_code == 422, response.text
        assert response.json()["detail"]["code"] == expected
        save("r6-refusal-" + expected, response.json())
    page, code, selected, receipt = select_bound_page(binding, [], "unknown", root / "templates")
    assert code == "PAGE_UNKNOWN" and selected is None
    active = root / "templates" / f"{PROFILE}.json"
    original = json.loads(active.read_text())
    active.write_text(json.dumps(dict(original, enabled=False)))
    disabled = upload(live, root, binding)
    assert disabled.status_code == 422, disabled.text
    assert disabled.json()["detail"]["code"] == "PAGE_TEMPLATE_DISABLED"
    save("r6-refusal-PAGE_TEMPLATE_DISABLED", disabled.json())
    active.write_text(json.dumps(original))
    registry_path = root / "contracts/profiles.json"
    registry = json.loads(registry_path.read_text())
    opposing_id = "tact5.process_settings.conflict"
    opposing = dict(original, profile_id=opposing_id)
    (root / "templates" / f"{opposing_id}.json").write_text(json.dumps(opposing))
    registry["profiles"].append(dict(profile_id=opposing_id, template=f"{opposing_id}.json"))
    registry_path.write_text(json.dumps(registry))
    conflict = upload(live, root, binding)
    assert conflict.status_code == 422, conflict.text
    assert conflict.json()["detail"]["code"] == "PAGE_TEMPLATE_CONFLICT"
    save("r6-refusal-PAGE_TEMPLATE_CONFLICT", conflict.json())


def test_a18_old_packages_v1_and_independent_get_reopen(live, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import page_template_admin as admin
    from export_page_package import export_page_package

    frozen = [ROOT / "templates/versions" / PROFILE / (version + ".json") for version in ("0.1.1", "0.2.0")]
    frozen.append(ROOT / "templates" / f"{PROFILE}.json")
    before = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in frozen}
    monkeypatch.setattr(admin, "ROOT", ROOT)
    app = FastAPI()
    app.include_router(admin.router)
    for _ in range(2):
        with TestClient(app) as reopened:
            package = reopened.get(f"/api/v1/page-templates/{PROFILE}/package", params={"version": VERSION})
            assert package.status_code == 200, package.text
            assert import_raw_package(package.json()) == tact5_package()
    result = subprocess.run([sys.executable, "scripts/export_page_package.py", PROFILE, VERSION],
                            cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert import_raw_package(json.loads(result.stdout)) == tact5_package()
    legacy = upload(live, ROOT, version="v1")
    assert legacy.status_code == 200, legacy.text
    old_observation = legacy.json()["page_observations"]
    assert old_observation["version"] == "1.0" and "schema_version" not in old_observation
    assert any(field["state"] == "unknown" for field in old_observation["fields"])
    old_package = export_page_package(PROFILE, "0.2.1")
    assert old_package["package_schema"] == "hmi_page_package.v1"
    assert old_package["template"]["layout_anchors"] == ["VSL1", "Pp1", "SM", "计量前", "计量后"]
    assert tact5_package()["template"]["layout_anchors"] == old_package["template"]["layout_anchors"]
    assert export_page_package(PROFILE, "0.2.2")["template"]["version"] == "0.2.2"
    assert {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in frozen} == before
    save("r6-legacy-response", legacy.json())
    save("r6-frozen-readback", dict(package_sha256=canonical_hash(tact5_package()), legacy_hashes=before))


def test_a17_sample_inventory_and_independent_acceptance_material(live):
    definition = tact5_package()["raw_field_definition"]
    images = []
    for sample in definition["samples"]:
        image = ROOT / sample["image"]
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        assert digest == sample["image_sha256"]
        images.append(dict(sample_id=sample["sample_id"], purpose=sample["purpose"], image_sha256=digest))
    save("r6-sample-inventory", dict(images=images, unique_hashes=len({row["image_sha256"] for row in images}),
                                    coverage=definition["coverage"], limitations=definition["limitations"]))
    manifest = json.loads((ROOT / "datasets/r6_nissei" / PROFILE / "acceptance/manifest.json").read_text())
    assert manifest["package_version"] == VERSION
    assert manifest["package_sha256"] == canonical_hash(tact5_package())
    independent = [sample for sample in manifest["samples"] if sample.get("initial_purpose", sample["purpose"]) == "independent_acceptance"]
    assert independent
    development = {sample["image_sha256"] for sample in definition["samples"]}
    regression = json.loads((ROOT / "datasets/r6_nissei" / PROFILE / "regression/manifest.json").read_text())
    development.update(sample["image_sha256"] for sample in regression["samples"])
    for sample in manifest["samples"]:
        assert sample["purpose"] in ("independent_acceptance", "diagnostic_regression")
        image = ROOT / sample["image"]
        assert hashlib.sha256(image.read_bytes()).hexdigest() == sample["image_sha256"]
        assert sample["image_sha256"] not in development
        truth_bytes = (ROOT / sample["truth"]).read_bytes()
        assert hashlib.sha256(truth_bytes).hexdigest() == sample["truth_sha256"]
        truth = json.loads(truth_bytes)
        receipt = json.loads((ROOT / sample["source_receipt"]).read_text())
        assert receipt["sha256"] == truth["image_sha256"] == sample["image_sha256"]
        assert receipt["source"] == "tact5_images"
        assert receipt["recordId"] == truth["provenance"]["record_id"]
        assert truth["provenance"]["tuning_involvement"] == (
            "shared_routing_diagnostic" if sample.get("partial_evaluation") else "entrypoint_config_diagnostic")
        assert truth["provenance"]["package_sha256"] == manifest["package_sha256"]
        assert set(truth["values"]) == {field["screen_field_key"] for field in definition["fields"]}
        import cv2
        from rectify import rectify
        directory = Path(tempfile.mkdtemp(prefix="r6-holdout-", dir=OUTPUT))
        meta = rectify(image, directory / "sample.png", directory / "sample.rectify.json")
        assert meta["ok"] and meta["original_sha256"] == sample["image_sha256"]
        lines = []
        for points, (text, confidence) in live["engine"].ocr(str(directory / "sample.png"), cls=False)[0] or []:
            xs, ys = zip(*points)
            lines.append(dict(text=text, conf=float(confidence), bbox=dict(
                x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
        (directory / "sample.ocr.json").write_text(json.dumps(dict(lines=lines)))
        observation = observe_tact5_page(lines, meta, sample["image_sha256"],
                                        cv2.imread(str(directory / "sample.png"), cv2.IMREAD_GRAYSCALE))
        response = upload(live, ROOT, hint(tact5_package()), sample=image)
        assert response.status_code == 200, response.text
        command = [sys.executable, "scripts/extract_fields.py", "sample", "--rectified-dir", str(directory),
                   "--output-dir", str(directory / "extracted"), "--observations-version", "v2",
                   "--original-image", str(image)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=90)
        unbound_cli = None
        if sample.get("partial_evaluation"):
            (directory / "unbound-cli.log").write_text(result.stdout + result.stderr)
            assert result.returncode == 0, result.stderr
            unbound_cli = json.loads((directory / "extracted/sample.fields.json").read_text())
            binding_path = directory / "binding.json"
            binding_path.write_text(json.dumps(hint(tact5_package())))
            result = subprocess.run(command + ["--output-dir", str(directory / "bound"),
                                    "--controller-hint", str(binding_path)], cwd=ROOT,
                                    capture_output=True, text=True, timeout=90)
        (directory / "cli.log").write_text(result.stdout + result.stderr)
        surfaces = [("direct", observation), ("http", response.json()["page_observations"])]
        if sample.get("partial_evaluation"):
            assert result.returncode == 2 and "PAGE_UNKNOWN" in result.stderr
            assert not (directory / "bound/sample.fields.json").exists()
            assert unbound_cli["profile_id"] == PROFILE
            surfaces.append(("cli", unbound_cli["page_observations"]))
            save("r6-holdout-" + sample["sample_id"] + "-cli-refusal", dict(
                exit_code=result.returncode, stderr=result.stderr))
        else:
            assert result.returncode == 0, result.stdout + result.stderr
            cli = json.loads((directory / "extracted/sample.fields.json").read_text())
            surfaces.append(("cli", cli["page_observations"]))
        for surface, record in surfaces:
            validate_raw_record(record, tact5_package())
            assert record["image_sha256"] == sample["image_sha256"]
            save("r6-holdout-" + sample["sample_id"] + "-" + surface, record)
            observed = by_key(record)
            for key, expected in truth["values"].items():
                field = observed[key]
                assert field["role"] == expected["role"], (surface, key, field)
                if expected["support"] == "unsupported":
                    assert field["reading"] == "unsupported" and field["original_value"] is None
                    continue
                if sample.get("partial_evaluation"):
                    if key in sample["expected_missing_fields"]:
                        assert field["reading"] == "missing" and field["original_value"] is None
                        assert field["state"] == "unknown" and field["original_bbox"] is None
                        continue
                    assert field["original_value"] == expected["original_value"], (surface, key, field, expected)
                    assert field["reading"] in ("known", "uncertain")
                    assert field["state"] in ("unknown", expected["state"])
                else:
                    for name in ("original_value", "state", "reading"):
                        assert field[name] == expected[name], (surface, key, name, field, expected)
                assert field["effective_unit"] == expected["unit"]
                assert field["original_bbox"] and field["bbox"]
            if sample.get("partial_evaluation"):
                assert set(record["coverage"]["missing"]) == set(sample["expected_missing_fields"])
                assert sum(f["reading"] in ("known", "uncertain") for f in record["fields"]) == sample["expected_observed_fields"]
            assert record["coverage"]["status"] == "partial"
        save("r6-independent-acceptance-manifest", manifest)


def test_authorized_dataset_regressions_keep_original_values_and_exposure(live):
    import cv2
    from rectify import rectify

    manifest = json.loads((ROOT / "datasets/r6_nissei" / PROFILE / "regression/manifest.json").read_text())
    assert len(manifest["samples"]) == 4
    for sample in manifest["samples"]:
        assert sample["purpose"] == "historical_regression_not_independent_acceptance"
        assert sample["provenance"]["historical_evaluation_status"] in (
            "development_exposed_not_independent_test", "same_capture_record_as_development_exposed_53934a60")
        image = ROOT / sample["image"]
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        assert digest == sample["image_sha256"]
        directory = Path(tempfile.mkdtemp(prefix="r6-regression-", dir=OUTPUT))
        meta = rectify(image, directory / "sample.png", directory / "sample.rectify.json")
        assert meta["ok"] and meta["original_sha256"] == digest
        lines = []
        for points, (text, confidence) in live["engine"].ocr(str(directory / "sample.png"), cls=False)[0] or []:
            xs, ys = zip(*points)
            lines.append(dict(text=text, conf=float(confidence), bbox=dict(
                x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
        assert lines
        (directory / "sample.ocr.json").write_text(json.dumps(dict(lines=lines)))
        command = [sys.executable, "scripts/extract_fields.py", "sample", "--rectified-dir", str(directory),
                   "--output-dir", str(directory / "extracted"), "--observations-version", "v2",
                   "--original-image", str(image)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=90)
        (directory / "cli.log").write_text(result.stdout + result.stderr)
        direct = observe_tact5_page(lines, meta, digest,
                                   cv2.imread(str(directory / "sample.png"), cv2.IMREAD_GRAYSCALE))
        surfaces = [("direct-diagnostic", direct)]
        if sample["cli_expected"] == "RAW_PAGE_UNSUPPORTED":
            assert result.returncode == 2, result.stdout + result.stderr
            assert "RAW_PAGE_UNSUPPORTED" in result.stderr
            assert not (directory / "extracted/sample.fields.json").exists()
            assert not any(line["text"] == "计量后" for line in lines)
            assert any(line["text"] == "计贝后" for line in lines)
            save("r6-regression-" + sample["sample_id"] + "-refusal", dict(
                exit_code=result.returncode, reason=sample["cli_limitation"], stderr=result.stderr))
        else:
            assert sample["cli_expected"] == "recognized_partial"
            assert result.returncode == 0, result.stdout + result.stderr
            cli = json.loads((directory / "extracted/sample.fields.json").read_text())
            surfaces.append(("cli", cli["page_observations"]))
        for surface, record in surfaces:
            assert record["image_sha256"] == digest
            validate_raw_record(record, tact5_package())
            fields = by_key(record)
            for key, expected in sample["expected_values"].items():
                assert fields[key]["original_value"] == expected, (sample["sample_id"], key, fields[key])
                assert fields[key]["reading"] in ("known", "uncertain")
                assert fields[key]["original_bbox"] and fields[key]["bbox"]
            assert record["coverage"]["status"] == "partial"
            assert fields["holding.ramp.1"]["reading"] == "unsupported"
            save("r6-regression-" + sample["sample_id"] + "-" + surface, record)


def test_real_feishu_local_tact5_sidecar_preserves_disabled_residual():
    from feishu_card_assistant import process_hmi_image, build_feishu_card

    sample = ROOT / "datasets/r6_nissei" / PROFILE / "acceptance/TACT5_reczz28QojrlL6Cy.jpg"
    truth = json.loads((sample.parent / "truth.json").read_text())
    directory = Path(tempfile.mkdtemp(prefix="r6-feishu-local-", dir=OUTPUT))
    result = process_hmi_image(sample, directory)
    save("r6-feishu-local-response", result)
    save("r6-feishu-local-card", build_feishu_card(result))
    assert result["profile_id"] == PROFILE
    legacy = {field["label"]: field for field in result["page_observations"]["fields"]}
    assert legacy["VS2"]["value"] == 90, legacy["VS2"]
    assert legacy["VS2"]["state"] == "disabled"
    sidecar = directory / "rectified" / (sample.stem + ".ocr.json")
    assert json.loads(sidecar.read_text())["lines"]
    command = [sys.executable, "scripts/extract_fields.py", sample.stem,
               "--rectified-dir", str(directory / "rectified"), "--output-dir", str(directory / "v2"),
               "--observations-version", "v2", "--original-image", str(sample)]
    process = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=180)
    (directory / "cli.log").write_text(process.stdout + process.stderr)
    assert process.returncode == 0, process.stdout + process.stderr
    record = json.loads((directory / "v2" / (sample.stem + ".fields.json")).read_text())["page_observations"]
    validate_raw_record(record, tact5_package())
    fields = by_key(record)
    assert fields["plasticizing.speed.2"]["original_value"] == 90
    assert fields["plasticizing.speed.2"]["state"] == "disabled"
    assert fields["plasticizing.speed.2"]["reading"] == "known"
    for key, expected in truth["values"].items():
        field = fields[key]
        assert field["role"] == expected["role"]
        if expected["support"] == "unsupported":
            assert field["reading"] == "unsupported" and field["original_value"] is None
            continue
        for name in ("original_value", "state", "reading"):
            assert field[name] == expected[name], (key, name, field, expected)
        assert field["effective_unit"] == expected["unit"]
        assert field["original_bbox"] and field["bbox"]
    save("r6-feishu-sidecar-v2-response", record)


def test_real_feishu_local_tact5_incomplete_anchors_never_use_legacy_tact():
    from feishu_card_assistant import process_hmi_image, build_feishu_card

    image = ROOT / "datasets/r6_nissei" / PROFILE / "acceptance/TACT5_reczz28QojrlL6pf.jpg"
    directory = Path(tempfile.mkdtemp(prefix="r6-incomplete-local-", dir=OUTPUT))
    result = process_hmi_image(image, directory)
    card = build_feishu_card(result)
    save("r6-incomplete-feishu-local-response", result)
    save("r6-incomplete-feishu-local-card", card)
    assert result["status"] == "review"
    assert result["classification"]["ui_family"] == "TACT5"
    assert result["classification"]["page"] == "process_settings"
    assert result["profile_id"] == PROFILE and result["template_version"] == "0.2.2"
    assert not result.get("fields")  # Raw observations, not legacy business imports.
    observed = {f["label"]: f for f in result["page_observations"]["fields"]}
    assert observed["Pp1"]["value"] == 110
    assert observed["Pp2"]["value"] == 95
    assert observed["Pp1"]["line_indexes"][1] != observed["Pp2"]["line_indexes"][1]
    assert observed["Pp1"]["bbox"] != observed["Pp2"]["bbox"]
    assert not any("GENERIC_FALLBACK" in warning for warning in result["warnings"])
    assert card["header"]["template"] == "orange"
    assert "holding_pressure_mpa" not in json.dumps(card)
    assert "95.0, 95.0" not in json.dumps(card)

    # Removing both retract headers leaves incompatible PB/VSL evidence, not a legacy TACT page.
    from extract_fields import extract_one
    rectified = directory / "rectified"
    source = json.loads((rectified / (image.stem + ".ocr.json")).read_text())
    source["lines"] = [line for line in source["lines"]
                       if "计量前" not in line["text"] and "计量后" not in line["text"]]
    (rectified / "incomplete.ocr.json").write_text(json.dumps(source))
    shutil.copyfile(rectified / (image.stem + ".rectify.json"), rectified / "incomplete.rectify.json")
    shutil.copyfile(rectified / (image.stem + ".png"), rectified / "incomplete.png")
    refused = extract_one("incomplete", rectified, None, None, ROOT / "templates")
    assert refused["status"] == "reject" and "PAGE_BINDING_MISMATCH" in refused["warnings"]
    assert not refused.get("fields") and not refused.get("page_observations")
    assert not any("GENERIC_FALLBACK" in warning for warning in refused["warnings"])
    save("r6-contradictory-legacy-refusal", refused)
