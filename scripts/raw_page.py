"""Versioned raw numeric page observations, independent of business projection."""

import copy
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = "demag.injection_metering.multi_stage_holding"
DEFINITION = "contracts/raw-pages/demag-holding-0.3.0.json"


def content_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def load_raw_definition(root=ROOT):
    return json.loads((root / DEFINITION).read_text())


def raw_page_package(profile_id, version, root=ROOT):
    if profile_id != PROFILE or version != "0.3.0":
        raise ValueError("RAW_PAGE_VERSION_UNSUPPORTED")
    frozen = root / "templates/raw-packages" / PROFILE / f"{version}.json"
    if not frozen.is_file():
        raise ValueError("RAW_PACKAGE_NOT_FROZEN")
    pinned = json.loads(frozen.read_text())
    for key, value in build_raw_page_package(root).items():
        if value != pinned.get(key):
            raise ValueError("RAW_PACKAGE_FROZEN_CONTENT_MISMATCH: " + key)
    return pinned


def build_raw_page_package(root=ROOT):
    profile_id, version = PROFILE, "0.3.0"
    definition = load_raw_definition(root)
    contract = json.loads((root / "contracts/page_observations.v2.schema.json").read_text())
    implementation = {path: hashlib.sha256((root / path).read_bytes()).hexdigest()
                      for path in ("scripts/raw_page.py", "scripts/raw_page_ocr.py",
                                   "scripts/extract_families/coordinates.py",
                                   "scripts/extract_families/demag/curve.py", "scripts/quality.py",
                                   "scripts/raw_contract.py")}
    package = {"package_schema": "hmi_raw_page_package.v2", "profile_id": profile_id,
            "version": version, "raw_field_definition": definition,
            "raw_field_definition_sha256": content_hash(definition),
            "raw_contract": contract, "raw_contract_sha256": content_hash(contract),
            "samples": [json.loads((root / "contracts/raw-pages/demag-holding-sample.json").read_text())],
            "recognizer": {"id": "demag_holding_numeric.v2",
                           "sha256": content_hash(implementation), "files": implementation},
            "legacy_package": {"version": "0.2.1",
                               "sha256": content_hash(json.loads((root / "templates/packages" / PROFILE / "0.2.1.json").read_text()))}}
    return package


def _line_box(line):
    box = line["bbox"]
    return [box[k] for k in ("x_min", "y_min", "x_max", "y_max")] if isinstance(box, dict) else box


def _inside(line, region, size):
    x1, y1, x2, y2 = _line_box(line)
    x, y = (x1 + x2) / (2 * size[0]), (y1 + y2) / (2 * size[1])
    return region[0] <= x <= region[2] and region[1] <= y <= region[3]


def observe_raw_page(profile_id, lines, meta, image_sha256, rectified_image=None):
    if profile_id != PROFILE:
        raise ValueError("RAW_PAGE_UNSUPPORTED")
    if not re.fullmatch(r"[0-9a-f]{64}", image_sha256):
        raise ValueError("IMAGE_HASH_INVALID")
    from extract_families.coordinates import project_boxes

    package = raw_page_package(PROFILE, "0.3.0")
    definition = package["raw_field_definition"]
    transform = copy.deepcopy(meta)
    transform["rectifier_input_sha256"] = transform.get("original_sha256")
    transform["original_sha256"] = image_sha256
    size = meta["screen_size"]
    observations, issues = [], copy.deepcopy(definition["issues"])
    numeric = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*(mm/s|bar_spez|bar|mm|s)?\s*$")
    for spec in definition["fields"]:
        candidates = [(index, line) for index, line in enumerate(lines)
                      if _inside(line, spec["region"], size) and numeric.fullmatch(line["text"])]
        source = candidates[0][1] if len(candidates) == 1 else None
        match = numeric.fullmatch(source["text"]) if source else None
        value = float(match[1]) if match else None
        confidence = source.get("conf", source.get("confidence", 0)) if source else None
        labels = [line["text"] for line in lines if spec.get("label_region")
                  and _inside(line, spec["label_region"], size)]
        original_unit = match[2] if match else None
        if original_unit is None:
            original_unit = next((unit for unit in ("mm/s", "bar_spez", "bar", "mm", "s")
                                  if any(re.search(r"(?<![a-z])" + re.escape(unit) + r"(?![a-z])", label)
                                         for label in labels)), None)
        reading = ("conflict" if len(candidates) > 1 else "missing" if source is None else
                   "uncertain" if confidence < .9 else "known")
        if spec.get("reading_support") == "unsupported":
            reading = "unsupported"
        elif spec.get("semantic_status") == "unverified" and source:
            reading = "uncertain"
        observation = {"screen_field_key": spec["screen_field_key"],
                       "source": "image_recognition", "original_label": " ".join(labels) or None,
                       "original_value": value, "original_unit": original_unit,
                       "effective_unit": original_unit or spec["unit"],
                       "label": spec["label"], "value": value, "unit": original_unit or spec["unit"],
                       "role": spec["role"], "state": "unknown", "reading": reading,
                       "section": spec["section"], "stage": spec.get("stage"),
                       "segment_id": spec.get("segment_id"), "order": spec.get("order"),
                       "text": source["text"] if source else None, "confidence": confidence,
                       "bbox": _line_box(source) if source else None, "original_bbox": None,
                       "line_indexes": [index for index, _ in candidates], "reasons": [],
                       "template_ref": {"profile_id": PROFILE, "version": definition["version"],
                                        "sha256": package["raw_field_definition_sha256"],
                                        "role": spec["role"],
                                        "unit": spec["unit"] if original_unit is None else None}}
        if reading != "known":
            issues.append({"code": "READING_" + reading.upper(), "screen_field_key": spec["screen_field_key"],
                           "reason": "No verified checkbox decoder" if reading == "unsupported" else "OCR evidence incomplete or uncertain"})
        if original_unit and spec["unit"] and original_unit != spec["unit"]:
            issues.append({"code": "UNIT_TEMPLATE_CONFLICT", "screen_field_key": spec["screen_field_key"]})
        observations.append(observation)
    if rectified_image is not None:
        from extract_families.demag.curve import _stage_enabled

        captures = {field["screen_field_key"]: [((field["bbox"][0] + field["bbox"][2]) / (2 * size[0]),
                                               (field["bbox"][1] + field["bbox"][3]) / (2 * size[1]))]
                    for field in observations if field["stage"] is not None and field["bbox"]}
        states = _stage_enabled(rectified_image, captures)
        for field in observations:
            state = states.get(field["screen_field_key"])
            if state:
                field["state"] = "enabled" if state[0] else "disabled"
                field["state_basis"] = "calibrated_cell_brightness.v1"
            if field["screen_field_key"] == "holding.pressure.stage-3":
                field["state"] = "unknown"
                field["state_basis"] = "conflicting_recorded_truth"
    project_boxes(observations, meta)
    for field in observations:
        if field["original_bbox"] is None:
            field["reasons"].append("source_box_unavailable")
    return {"schema_version": "page_observations.v2", "profile_id": PROFILE,
            "page_identity": definition["page_identity"], "source": "image_recognition",
            "image_sha256": image_sha256, "original_size": meta.get("original_size"),
            "coordinate_space": "original_percent", "transform": transform,
            "raw_contract_sha256": package["raw_contract_sha256"],
            "raw_field_definition_version": definition["version"],
            "raw_field_definition_sha256": package["raw_field_definition_sha256"],
            "recognizer": package["recognizer"], "package_sha256": content_hash(package),
            "ocr_evidence": {"coordinate_space": "rectified_pixels", "screen_size": size,
                             "lines": lines},
            "fields": observations, "issues": issues,
            "coverage": {"status": "partial" if issues else "complete",
                         "declared": len(observations),
                         "known": sum(field["reading"] == "known" for field in observations)}}
