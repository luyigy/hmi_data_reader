"""Frozen TACT5 OCR observations with physical field identities."""

import copy
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from extract_families.tact5_process import extract_tact5
from raw_contract import canonical_hash, import_raw_package, validate_raw_record

ROOT = Path(__file__).resolve().parents[1]
PROFILE = "tact5.process_settings.injection_holding_metering"
VERSION = "0.6.0"
DEFINITION = "contracts/raw-pages/tact5-process-0.6.0.json"
FILES = ("scripts/raw_tact5.py", "scripts/extract_families/tact5_process.py",
         "scripts/extract_families/common.py", "scripts/extract_families/coordinates.py",
         "scripts/quality.py", "scripts/raw_contract.py")


def build_tact5_package(root=ROOT):
    root = Path(root)
    definition = json.loads((root / DEFINITION).read_text())
    template = json.loads((root / "templates/raw-recognizers/tact5.process_ocr.v2/0.6.0/template.json").read_text())
    template.update(version=VERSION, extractor="registered_extractor", extractor_id="tact5.process_settings",
                    extractor_version="1", page_identity=dict(definition["page_identity"],
                    evidence_sample_ids=[sample["sample_id"] for sample in definition["samples"]]))
    contract = json.loads((root / "contracts/page_observations.v2.schema.json").read_text())
    sources = {path: (ROOT / path).read_text() for path in FILES}
    files = {path: hashlib.sha256(source.encode()).hexdigest() for path, source in sources.items()}
    return dict(package_schema="hmi_raw_page_package.v2", profile_id=PROFILE, version=VERSION,
                template=template, raw_contract=contract, raw_contract_sha256=canonical_hash(contract),
                raw_field_definition=definition, raw_field_definition_sha256=canonical_hash(definition),
                recognizer=dict(id="tact5.process_ocr.v2", files=files, sources=sources,
                                sha256=canonical_hash(files)), samples=[dict(
                    manifest=dict(sample, profile_id=PROFILE, original_sha256=sample["image_sha256"]),
                    ocr=json.loads((root / sample["ocr"]).read_text())) for sample in definition["samples"]])


def tact5_package(root=ROOT, version=VERSION):
    if version != VERSION:
        raise ValueError("RAW_PAGE_VERSION_UNSUPPORTED")
    package = import_raw_package(json.loads(
        (Path(root) / "templates/raw-packages" / PROFILE / f"{version}.json").read_text()))
    if package != build_tact5_package(root):
        raise ValueError("RAW_PACKAGE_FROZEN_CONTENT_MISMATCH")
    return package


def observe_tact5_page(lines, meta, image_sha256, rectified_image=None, root=ROOT):
    if not re.fullmatch(r"[a-f0-9]{64}", image_sha256):
        raise ValueError("IMAGE_HASH_INVALID")
    package = tact5_package(root)
    extractor_lines = [dict(line, conf=line.get("conf", line.get("confidence", 0)),
                      bbox=line["bbox"] if isinstance(line["bbox"], dict) else
                      dict(zip(("x_min", "y_min", "x_max", "y_max"), line["bbox"]))) for line in lines]
    if rectified_image is None:
        legacy = extract_tact5(extractor_lines, package["template"], meta)
    else:
        import cv2
        with tempfile.TemporaryDirectory(prefix="tact5-state-", dir=os.environ.get("AP_GRAPH_OUTPUT_DIR")) as directory:
            path = Path(directory) / "screen.png"
            if not cv2.imwrite(str(path), rectified_image):
                raise ValueError("RECTIFIED_IMAGE_WRITE_FAILED")
            legacy = extract_tact5(extractor_lines, package["template"], meta, path)
    candidates = legacy["detail"]["page_observations"]
    fields, issues = [], []
    for spec in package["raw_field_definition"]["fields"]:
        hits = [field for field in candidates["fields"] if field["label"].casefold() == spec["label"].casefold()]
        observed = hits[0] if len(hits) == 1 else None
        value = observed["value"] if observed else None
        unit = observed["unit"] if observed else None
        confidence = observed["confidence"] if observed else None
        reading = ("unsupported" if spec.get("unsupported_reason") else "conflict" if len(hits) > 1
                   else "missing" if value is None else "uncertain" if confidence < .8 else "known")
        if unit is not None and unit != spec.get("unit"):
            reading = "conflict"
            issues.append(dict(code="UNIT_CONFLICT", screen_field_key=spec["screen_field_key"]))
        if reading != "known":
            issues.append(dict(code="FIELD_" + reading.upper(), screen_field_key=spec["screen_field_key"],
                               reason=spec.get("unsupported_reason")))
        label_indexes = observed["line_indexes"][:2 if spec.get("compound_label") else 1] if observed else []
        field = dict(screen_field_key=spec["screen_field_key"], source="image_recognition",
                     original_label=" ".join(lines[i]["text"] for i in label_indexes) or None,
                     original_value=value, original_unit=unit, effective_unit=unit or spec.get("unit"),
                     role=spec["role"], state=observed["state"] if observed else "unknown", reading=reading,
                     section=spec["section"], stage=spec.get("stage"), segment_id=spec.get("segment_id"),
                     confidence=confidence, text=observed["text"] if observed else None,
                     bbox=observed["bbox"] if observed else None,
                     original_bbox=observed["original_bbox"] if observed else None,
                     line_indexes=observed["line_indexes"] if observed else [],
                     state_basis=observed.get("state_basis") if observed else None,
                     reasons=observed["reasons"] if observed else [],
                     template_ref=dict(profile_id=PROFILE, version=VERSION,
                                       sha256=package["raw_field_definition_sha256"],
                                       unit=spec.get("unit") if unit is None else None))
        if len(hits) > 1:
            field["candidates"] = copy.deepcopy(hits)
        if spec.get("time_kind"):
            field["time_kind"] = spec["time_kind"]
        fields.append(field)
    for spec in package["raw_field_definition"]["fields"]:
        if not spec.get("stage"):
            continue
        group = [field for field in fields if field["section"] == spec["section"]
                 and field["screen_field_key"].rsplit(".", 1)[0] == spec["screen_field_key"].rsplit(".", 1)[0]
                 and field["bbox"]]
        group.sort(key=lambda field: field["bbox"][0])
        for order, field in enumerate(group, 1):
            field["order"] = order
    transform = copy.deepcopy(meta)
    transform.update(rectifier_input_sha256=meta.get("original_sha256"), original_sha256=image_sha256)
    record = dict(schema_version="page_observations.v2", profile_id=PROFILE, source="image_recognition",
                  page_identity=package["raw_field_definition"]["page_identity"],
                  image_sha256=image_sha256, original_size=meta.get("original_size"),
                  coordinate_space="original_percent", transform=transform,
                  raw_contract_sha256=package["raw_contract_sha256"],
                  raw_field_definition_sha256=package["raw_field_definition_sha256"],
                  raw_field_definition_version=VERSION, package_sha256=canonical_hash(package),
                  recognizer=package["recognizer"], engine={"library": "provided_ocr_sidecar"},
                  stage_counts=candidates["stage_counts"], visual_stage_counts=candidates["visual_stage_counts"],
                  fields=fields, issues=issues,
                  coverage=dict(status="partial" if issues else "complete",
                                missing=[field["screen_field_key"] for field in fields if field["reading"] == "missing"],
                                unsupported=[field["screen_field_key"] for field in fields if field["reading"] == "unsupported"]),
                  ocr_evidence=dict(coordinate_space="rectified_pixels", screen_size=meta["screen_size"], lines=lines))
    validate_raw_record(record, package)
    return record
