"""R6 FANUC originals, conservative observations, pinned packages and real callers."""

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
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from raw_contract import canonical_hash, validate_raw_record
from raw_fanuc_temperature import PROFILE, VERSION, fanuc_temperature_package, observe_fanuc_temperature
from raw_temperature_time import validate_temperature_time_record

OUTPUT = Path(os.environ["AP_GRAPH_OUTPUT_DIR"])


def test_real_feishu_local_caller_recognizes_temperature_without_gpu():
    from feishu_card_assistant import process_hmi_image, build_feishu_card

    image = ROOT / "datasets/calibration/fanuc.temperature.rightmost5/barrel_A11_3ce4cae5.jpg"
    directory = OUTPUT / "feishu-local"
    result = process_hmi_image(image, directory)
    card = build_feishu_card(result)
    (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    (directory / "card.json").write_text(json.dumps(card, ensure_ascii=False, indent=2))
    assert result["ocr_line_count"] > 0
    assert result["classification"]["ui_family"] == "FANUC"
    assert result["classification"]["page"] == "temperature"
    assert result["profile_id"] == PROFILE
    assert result["status"] != "reject"
    ocr = json.loads((directory / "rectified" / f"{image.stem}.ocr.json").read_text())
    assert ocr["line_count"] == len(ocr["lines"]) == result["ocr_line_count"]
    assert all(line["bbox"]["points"] for line in ocr["lines"])
    assert card["header"]["template"] != "red"


def test_z036_real_caller_does_not_report_unverified_values_as_success():
    from feishu_card_assistant import process_hmi_image, build_feishu_card

    review = json.loads((ROOT / "ground_truth/mc_z036_injection/Z036_rank04_full_page_visual_review.json").read_text())
    image = ROOT / review["image"]
    assert hashlib.sha256(image.read_bytes()).hexdigest() == review["image_sha256"]
    directory = OUTPUT / "z036-live"
    result = process_hmi_image(image, directory)
    card = build_feishu_card(result)
    (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    (directory / "card.json").write_text(json.dumps(card, ensure_ascii=False, indent=2))
    assert result["ocr_line_count"] > 0
    assert result["profile_id"] == "fanuc.injection_metering.injection_holding_metering"
    assert result["fields"]["back_pressure_mpa"] is None
    assert result["fields"]["decompress_position_mm"] is None
    assert result["status"] == "review" and card["header"]["template"] == "orange"
    assert "需要人工核验" in card["header"]["title"]["content"]
    issues = result["extraction_detail"]["field_issues"]
    by_field = {issue["field"]: issue for issue in issues}
    assert by_field["back_pressure_mpa"]["reading"] == "missing"
    rejected = by_field["decompress_position_mm"]
    assert rejected["reading"] == "uncertain"
    assert any(c["text"] == "00-9" and c["conf"] < .8 and c["bbox"]
               for c in rejected["candidates"])
    observations = {f["label"]: f for f in result["page_observations"]["fields"]}
    assert observations["手动背压"]["value"] is None
    assert observations["减压位置"]["value"] is None
    assert "手动背压" in " ".join(result["warnings"])
    assert "减压位置" in " ".join(result["warnings"])


@pytest.fixture(scope="module")
def live():
    import httpx
    import hmi_service as service
    from paddleocr import PaddleOCR
    from raw_page_ocr import engine_identity
    from rectify import rectify

    directory = OUTPUT / "r6-live"
    directory.mkdir(parents=True, exist_ok=True)
    engine = PaddleOCR(use_gpu=False, use_angle_cls=False, lang="ch", show_log=False)
    package = fanuc_temperature_package()
    samples = []
    previous = service.ocr_model, service.is_ready, service.concurrency_semaphore

    async def upload(image):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://reader") as client:
            return await client.post("/api/v1/recognize?observations_version=v2",
                files={"file": (image.name, image.read_bytes(), "image/jpeg")})

    try:
        service.ocr_model, service.is_ready = engine, True
        for sample in package["samples"]:
            image = ROOT / sample["image"]
            stem = image.stem
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            assert digest == sample["manifest"]["original_sha256"]
            meta = rectify(image, directory / f"{stem}.png", directory / f"{stem}.rectify.json")
            assert meta["ok"] and meta["original_sha256"] == digest
            lines = []
            for points, (text, confidence) in engine.ocr(str(directory / f"{stem}.png"), cls=False)[0] or []:
                xs, ys = zip(*points)
                lines.append(dict(text=text, conf=float(confidence), bbox=dict(
                    x_min=min(xs), y_min=min(ys), x_max=max(xs), y_max=max(ys))))
            assert lines
            (directory / f"{stem}.ocr.json").write_text(json.dumps(dict(lines=lines), ensure_ascii=False))
            record = observe_fanuc_temperature(lines, meta, digest)
            record["engine"] = engine_identity(engine)
            validate_raw_record(record, package)
            validate_temperature_time_record(record, package)
            allowed_sources = package["raw_contract"]["properties"]["fields"]["items"]["properties"]["zone_source"]["enum"]
            assert all(field.get("zone_source") in allowed_sources for field in record["fields"])
            (directory / f"{stem}.raw.json").write_text(json.dumps(record, ensure_ascii=False, indent=2))
            truth = yaml.safe_load((ROOT / sample["truth"]).read_text())
            samples.append(dict(sample=sample, image=image, meta=meta, lines=lines, record=record, truth=truth))
        service.concurrency_semaphore = asyncio.Semaphore(1)
        response = asyncio.run(upload(samples[0]["image"]))
        (directory / "http-response.json").write_text(json.dumps(response.json(), ensure_ascii=False, indent=2))
        assert response.status_code == 200, response.text
        http = response.json()
    finally:
        service.ocr_model, service.is_ready, service.concurrency_semaphore = previous
    return dict(samples=samples, directory=directory, http=http)


def by_key(record):
    return {field["screen_field_key"]: field for field in record["fields"]}


def test_a17_real_originals_development_and_retained_provenance(live):
    samples = live["samples"]
    assert len(samples) == 4
    groups = {purpose: {s["record"]["image_sha256"] for s in samples
                       if s["sample"]["manifest"]["purpose"] == purpose}
              for purpose in ("development", "retained")}
    assert len(groups["development"]) == len(groups["retained"]) == 2
    assert not groups["development"] & groups["retained"]
    checked = []
    for sample in samples:
        receipt = sample["sample"]
        assert hashlib.sha256((ROOT / receipt["truth"]).read_bytes()).hexdigest() == receipt["truth_sha256"]
        assert receipt["provenance"]["source"]["note"]
        assert receipt["provenance"]["verified_by"]
        checked.append(dict(image=receipt["image"], sha256=sample["record"]["image_sha256"],
                            purpose=receipt["manifest"]["purpose"], provenance=receipt["provenance"]))
        fields = by_key(sample["record"])
        values = sample["truth"]["fields"]
        for row, old in (("setting", "barrel_temperature_set_c"), ("actual", "barrel_temperature_current_c")):
            expected = list(values[old])
            if len(expected) == 4:
                expected.append(values[f"drop_port_temperature_{'set' if row == 'setting' else 'current'}_c"])
            for zone, value in zip(("nozzle-N", "barrel-B1", "barrel-B2", "barrel-B3", "feed-H"), expected):
                field = fields[f"temperature.{zone}.{row}"]
                if field["reading"] == "known":
                    assert field["original_value"] == value
                elif field["reading"] == "uncertain":
                    assert field["original_value"] is not None and field["state"] == "unknown"
                else:
                    assert field["reading"] == "missing" and field["original_value"] is None
    (OUTPUT / "r6-sample-provenance.json").write_text(json.dumps(checked, ensure_ascii=False, indent=2))


def test_a04_disabled_unknown_actual_missing_and_low_confidence_keep_evidence(live):
    sample = live["samples"][0]
    fields = by_key(sample["record"])
    hold = fields["temperature.low_hold.setting"]
    assert hold["original_value"] == 200 and hold["state"] == "disabled"
    assert hold["state_evidence"]["text"] == "OFF"
    assert hold["bbox"] and hold["original_bbox"] and hold["effective_unit"] == "°C"
    assert hold["original_unit"] is None and hold["template_ref"]["unit"] == "°C"
    assert fields["temperature.nozzle-N.actual"]["role"] == "actual"
    assert fields["temperature.nozzle-N.setting"]["state"] == "unknown"
    assert fields["temperature.nozzle-N.actual"]["reading"] == "uncertain"
    assert "shared_ocr_box" in fields["temperature.nozzle-N.actual"]["reasons"]
    lines = copy.deepcopy(sample["lines"])
    value = next(line for line in lines if line["text"] == "200.0")
    value["conf"] = .2
    record = observe_fanuc_temperature(lines, sample["meta"], sample["record"]["image_sha256"])
    field = by_key(record)["temperature.low_hold.setting"]
    assert field["reading"] == "uncertain" and field["original_value"] == 200
    assert field["state"] == "disabled" and field["original_bbox"]
    value["text"], value["conf"] = "-5.0", .99
    negative = by_key(observe_fanuc_temperature(lines, sample["meta"], sample["record"]["image_sha256"]))["temperature.low_hold.setting"]
    assert negative["original_value"] == -5 and negative["state"] == "disabled"
    lines.remove(value)
    field = by_key(observe_fanuc_temperature(lines, sample["meta"], sample["record"]["image_sha256"]))["temperature.low_hold.setting"]
    assert field["reading"] == "missing" and field["original_value"] is None
    assert field["state"] == "disabled"


def test_real_http_and_cli_use_v2_origin_hash_and_frozen_definition(live):
    http = live["http"]
    record = http["page_observations"]
    assert record["profile_id"] == PROFILE and record["schema_version"] == "page_observations.v2"
    assert record["image_sha256"] == live["samples"][0]["record"]["image_sha256"]
    assert record["raw_field_definition_sha256"] == fanuc_temperature_package()["raw_field_definition_sha256"]
    validate_raw_record(record, fanuc_temperature_package())
    assert by_key(record)["temperature.low_hold.setting"]["state"] == "disabled"
    sample = live["samples"][0]
    command = [sys.executable, "scripts/extract_fields.py", sample["image"].stem,
               "--rectified-dir", str(live["directory"]), "--output-dir", str(live["directory"] / "cli"),
               "--observations-version", "v2", "--original-image", str(sample["image"]),
               "--record-report", str(live["directory"] / "absent"), "--labels", str(live["directory"] / "absent")]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=180)
    (OUTPUT / "r6-cli.log").write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stdout + result.stderr
    cli = json.loads((live["directory"] / "cli" / f"{sample['image'].stem}.fields.json").read_text())
    assert cli["page_observations"]["profile_id"] == PROFILE
    assert cli["page_observations"]["image_sha256"] == record["image_sha256"]
    assert by_key(cli["page_observations"])["temperature.low_hold.setting"]["state"] == "disabled"


def test_a07_bound_page_unknown_wrong_binding_disabled_conflict_and_incompatible(live):
    from scripts.extract_fields import extract_one

    root = Path(tempfile.mkdtemp(prefix="r6-bound-", dir=OUTPUT))
    shutil.copytree(ROOT / "templates", root / "templates")
    shutil.copytree(ROOT / "contracts", root / "contracts")
    package = fanuc_temperature_package()
    hint = dict(brand="FANUC", controller_family="FANUC", interface_generation=None, binding_revision=1,
                pages=[dict(profile_id=PROFILE, version=VERSION, package_sha256=canonical_hash(package))])
    lines = live["samples"][0]["lines"]
    def select(binding=hint, evidence=lines):
        (root / "probe.ocr.json").write_text(json.dumps(dict(lines=evidence)))
        (root / "probe.rectify.json").write_text(json.dumps(live["samples"][0]["meta"]))
        result = extract_one("probe", root, {}, {}, root / "templates", controller_hint=binding)
        code = result["compatibility"]["code"]
        if code != "PAGE_COMPATIBLE":
            assert not result.get("fields")
            assert not any("GENERIC_FALLBACK" in warning for warning in result["warnings"])
        return code
    assert select() == "PAGE_COMPATIBLE"
    assert select({**hint, "controller_family": "EST"}) == "PAGE_BINDING_MISMATCH"
    assert select(evidence=[dict(text="unknown panel", conf=.99, bbox=dict(x_min=1, y_min=1, x_max=100, y_max=10))]) == "PAGE_UNKNOWN"
    assert select({**hint, "pages": [{**hint["pages"][0], "package_sha256": "0" * 64}]}) == "PAGE_PACKAGE_INCOMPATIBLE"
    active = root / "templates/fanuc/temperature.json"
    original = active.read_bytes()
    disabled = json.loads(original)
    disabled["enabled"] = False
    active.write_text(json.dumps(disabled))
    assert select() == "PAGE_TEMPLATE_DISABLED"
    active.write_bytes(original)
    registry = root / "contracts/profiles.json"
    old = registry.read_bytes()
    data = json.loads(old)
    other = {**package["template"], "profile_id": "fanuc.temperature.ambiguous"}
    (root / "templates/ambiguous.json").write_text(json.dumps(other))
    data["profiles"].append(dict(profile_id=other["profile_id"], template="ambiguous.json"))
    registry.write_text(json.dumps(data))
    assert select() == "PAGE_TEMPLATE_CONFLICT"
    registry.write_bytes(old)
    frozen = root / "templates/packages" / PROFILE / f"{VERSION}.json"
    original_package = frozen.read_bytes()
    incompatible = copy.deepcopy(package)
    incompatible["template"]["contract_version"] = "unsupported"
    frozen.write_text(json.dumps(incompatible))
    bad_hint = {**hint, "pages": [{**hint["pages"][0], "package_sha256": canonical_hash(incompatible)}]}
    assert select(bad_hint) == "EXTRACTOR_CONTRACT_INCOMPATIBLE"
    frozen.write_bytes(original_package)


def test_a11_stable_identity_reorder_duplicate_and_missing_rows(live):
    sample = live["samples"][0]
    record = copy.deepcopy(sample["record"])
    assert len(record["fields"]) == 11
    record["fields"] = list(reversed(record["fields"]))
    assert validate_temperature_time_record(record, fanuc_temperature_package()) == record
    for field in record["fields"]:
        if field.get("zone_id"):
            field["order"] = 6 - field["order"]
    validate_temperature_time_record(record, fanuc_temperature_package())
    duplicate = copy.deepcopy(record)
    duplicate["fields"].append(copy.deepcopy(record["fields"][-1]))
    with pytest.raises(ValueError, match="RAW_FIELD_IDENTITY_CONFLICT"):
        validate_temperature_time_record(duplicate, fanuc_temperature_package())
    lines = copy.deepcopy(sample["lines"])
    header = next(line for line in lines if line["text"] == "B3")
    lines.append(copy.deepcopy(header))
    observed = observe_fanuc_temperature(lines, sample["meta"], record["image_sha256"])
    assert any(i["code"] == "ZONE_IDENTITY_CONFLICT" for i in observed["issues"])
    assert all(f["reading"] == "conflict" for f in observed["fields"] if f.get("zone_id"))
    lines = [line for line in sample["lines"] if line["text"] != "现在"]
    observed = observe_fanuc_temperature(lines, sample["meta"], record["image_sha256"])
    assert all(f["reading"] == "missing" for f in observed["fields"] if f["role"] == "actual")
    reordered = copy.deepcopy(sample["lines"])
    header = next(line for line in reordered if line["text"] == "B3")
    nozzle = copy.deepcopy(header)
    nozzle["text"] = "N"
    width = sample["meta"]["screen_size"][0]
    shift = .425 * width - (nozzle["bbox"]["x_min"] + nozzle["bbox"]["x_max"]) / 2
    nozzle["bbox"]["x_min"] += shift
    nozzle["bbox"]["x_max"] += shift
    reordered.append(nozzle)
    normal = by_key(observe_fanuc_temperature(reordered, sample["meta"], record["image_sha256"]))
    nozzle["text"], header["text"] = header["text"], nozzle["text"]
    swapped = by_key(observe_fanuc_temperature(reordered, sample["meta"], record["image_sha256"]))
    assert normal["temperature.nozzle-N.actual"]["original_value"] == 289.9
    assert swapped["temperature.barrel-B3.actual"]["original_value"] == 289.9
    assert swapped["temperature.nozzle-N.actual"]["original_value"] == 269.8
    assert swapped["temperature.barrel-B3.actual"]["order"] == 1
    assert swapped["temperature.nozzle-N.actual"]["order"] == 4


def test_a18_v1_values_and_frozen_package_get_reopen(live):
    import page_template_admin as admin
    from export_page_package import export_page_package
    from extract_families.fanuc import extract_temperature_fanuc

    old = json.loads((ROOT / "templates/fanuc.temperature.json").read_text())
    new = json.loads((ROOT / "templates/fanuc/temperature.json").read_text())
    for sample in live["samples"]:
        w, h = sample["meta"]["screen_size"]
        tokens = [dict(text=line["text"], conf=line["conf"], x=(line["bbox"]["x_min"] + line["bbox"]["x_max"]) / (2*w),
                       y=(line["bbox"]["y_min"] + line["bbox"]["y_max"]) / (2*h)) for line in sample["lines"]]
        assert extract_temperature_fanuc(tokens, old) == extract_temperature_fanuc(tokens, new)
    package = export_page_package(PROFILE, VERSION)
    assert package == fanuc_temperature_package()
    app = FastAPI()
    app.include_router(admin.router)
    for _ in range(2):
        with TestClient(app) as client:
            response = client.get(f"/api/v1/page-templates/{PROFILE}/package", params=dict(version=VERSION))
            assert response.status_code == 200, response.text
            assert response.json() == package
            assert client.get(f"/api/v1/page-templates/{PROFILE}/package").json() == package
    path = live["directory"] / "stored-observations.json"
    path.write_text(json.dumps(live["samples"][0]["record"]))
    assert validate_raw_record(json.loads(path.read_text()), package) == live["samples"][0]["record"]


def test_frozen_sample_trial_authenticated_publication_and_get(monkeypatch):
    import page_template_admin as admin

    root = Path(tempfile.mkdtemp(prefix="r6-publication-", dir=OUTPUT))
    shutil.copytree(ROOT / "templates", root / "templates")
    shutil.copytree(ROOT / "contracts", root / "contracts")
    package = fanuc_temperature_package()
    for sample in package["samples"]:
        path = Path(sample["manifest"]["ocr_fixture"])
        (root / path.parent).mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / path, root / path)
    registry = root / "contracts/profiles.json"
    content = json.loads(registry.read_text())
    content["profiles"] = [p for p in content["profiles"] if p["profile_id"] != PROFILE]
    registry.write_text(json.dumps(content))
    frozen = root / "templates/packages" / PROFILE / f"{VERSION}.json"
    before = frozen.read_bytes()
    frozen.rename(root / "prebuilt-fanuc-package.json")
    monkeypatch.setattr(admin, "ROOT", root)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "r6-isolated-key")
    app = FastAPI()
    app.include_router(admin.router)
    headers = dict(Authorization="Bearer r6-isolated-key")
    prefix = f"/api/v1/page-templates/drafts/{PROFILE}"
    request = dict(expected_version=None, template=package["template"], samples=package["samples"])
    with TestClient(app) as client:
        assert client.put(prefix, json=request).status_code == 401
        saved = client.put(prefix, json=request, headers=headers)
        assert saved.status_code == 200, saved.text
        trial = client.post(prefix + "/trial", json=dict(expected_revision=1), headers=headers)
        assert trial.status_code == 200, trial.text
        assert len(trial.json()["after"]) == 4
        published = client.post(prefix + "/publish", json=dict(expected_revision=1,
            expected_version=None, confirmation="publish_confirmed"), headers=headers)
        assert published.status_code == 200, published.text
        result = client.get(f"/api/v1/page-templates/{PROFILE}/package", params=dict(version=VERSION))
        assert result.status_code == 200, result.text
        assert result.json() == package
        published_bytes = frozen.read_bytes()
        repeated = client.post(prefix + "/publish", json=dict(expected_revision=1,
            expected_version=None, confirmation="publish_confirmed"), headers=headers)
        assert repeated.status_code == 409
        assert frozen.read_bytes() == published_bytes
    assert json.loads(frozen.read_text()) == json.loads(before)
    (OUTPUT / "r6-publication.json").write_text(json.dumps(dict(trial=trial.json(),
        publication=published.json(), package_sha256=canonical_hash(result.json())), ensure_ascii=False, indent=2))
