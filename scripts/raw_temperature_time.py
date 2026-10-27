"""Physical temperature zones and page-specific durations from OCR evidence."""

import copy
import hashlib
import json
import re
from pathlib import Path

try:
    from raw_page import PROFILE as HOLDING_PROFILE
    from raw_page import _inside, _line_box, content_hash
    from raw_contract import import_raw_package, validate_raw_record
except ModuleNotFoundError:
    from scripts.raw_page import PROFILE as HOLDING_PROFILE
    from scripts.raw_page import _inside, _line_box, content_hash
    from scripts.raw_contract import import_raw_package, validate_raw_record

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.4.1"
DEFINITIONS = {
    "demag.temperature.screen_order_5": "demag-temperature-0.4.1.json",
    "est.storage_cooling.cooling_delay": "est-storage-cooling-0.4.1.json",
}
NUMBER = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?|\d+:\d{2})\s*(°C|℃|°F|ms|min|s|bar|mm)?\s*$")


def select_raw_profile(profile_id, lines):
    texts = {re.sub(r"\s+", "", line["text"]) for line in lines}
    if profile_id in DEFINITIONS or profile_id == HOLDING_PROFILE:
        return profile_id
    # This is a registered OCR layout, not a fallback for blocked/conflicting pages.
    if profile_id == "generic.spatial" and {"储前冷却时间", "模具冷却时间", "储料背压"} <= texts:
        return "est.storage_cooling.cooling_delay"
    raise ValueError("RAW_PAGE_UNSUPPORTED")


def build_temperature_time_package(profile_id, root=ROOT, version=VERSION):
    definition = json.loads((root / "contracts/raw-pages" / DEFINITIONS[profile_id].replace(VERSION, version)).read_text())
    contract = json.loads((root / "contracts/page_observations.temperature-time.v2.schema.json").read_text())
    files = {path: hashlib.sha256((root / ("templates/raw-recognizers/temperature_time_ocr.v2/0.4.0"
                                         if version == "0.4.0" and path == "scripts/raw_temperature_time.py"
                                         else "") / path).read_bytes()).hexdigest() for path in
             ("scripts/raw_temperature_time.py", "scripts/raw_page.py", "scripts/raw_contract.py",
              "scripts/extract_families/coordinates.py")}
    return {"package_schema": "hmi_raw_page_package.v2", "profile_id": profile_id,
            "version": version, "raw_contract": contract, "raw_contract_sha256": content_hash(contract),
            "raw_field_definition": definition, "raw_field_definition_sha256": content_hash(definition),
            "recognizer": {"id": "temperature_time_ocr.v2", "files": files, "sha256": content_hash(files)},
            "samples": definition["samples"]}


def temperature_time_package(profile_id, version=VERSION, root=ROOT):
    if profile_id not in DEFINITIONS or version not in ("0.4.0", VERSION):
        raise ValueError("RAW_PAGE_VERSION_UNSUPPORTED")
    path = root / "templates/raw-packages" / profile_id / f"{version}.json"
    package = import_raw_package(json.loads(path.read_text()))
    if package != build_temperature_time_package(profile_id, root, version):
        raise ValueError("RAW_PACKAGE_FROZEN_CONTENT_MISMATCH")
    return package


def structure_issues(fields):
    issues, identities, orders, zone_orders = [], set(), {}, {}
    for field in fields:
        zone = field.get("zone_id")
        if zone is None:
            continue
        identity = (field.get("section"), zone, field["role"])
        if identity in identities:
            issues.append({"code": "ZONE_IDENTITY_CONFLICT", "zone_id": zone})
        identities.add(identity)
        order = field.get("order")
        group = (field.get("section"), field["zone_source"])
        if order is not None:
            previous = orders.setdefault((group, order), zone)
            if previous != zone:
                issues.append({"code": "ZONE_ORDER_CONFLICT", "zone_id": zone})
            previous_order = zone_orders.setdefault((group, zone), order)
            if previous_order != order:
                issues.append({"code": "ZONE_ORDER_CONFLICT", "zone_id": zone})
    return issues


def validate_temperature_time_record(record, package):
    definition = import_raw_package(package)["raw_field_definition"]
    specs = {spec["screen_field_key"]: spec for spec in definition["fields"]}
    # The base boundary requires the entire page. This extension allows absent physical zones.
    padded = copy.deepcopy(record)
    present = {field["screen_field_key"] for field in record["fields"]}
    present_zones = {field.get("zone_id") for field in record["fields"]}
    if record.get("source") == "image_recognition":
        for key in specs.keys() - present:
            if not specs[key].get("zone_id") or specs[key]["zone_id"] in present_zones:
                raise ValueError("RAW_FIELD_COVERAGE_INCOMPLETE")
            padded["fields"].append({"screen_field_key": key, "source": "image_recognition",
                                     "original_label": None, "original_value": None, "original_unit": None,
                                     "role": specs[key]["role"], "state": "unknown", "reading": "missing",
                                     "original_bbox": None})
    validate_raw_record(padded, package)
    for field in record["fields"]:
        spec = specs[field["screen_field_key"]]
        for key in ("zone_id", "zone_source", "role", "time_kind", "section"):
            if field.get(key) != spec.get(key):
                raise ValueError("RAW_PHYSICAL_IDENTITY_CONFLICT")
        if spec.get("zone_id") and (type(field.get("order")) is not int or field["order"] < 1):
            raise ValueError("ZONE_ORDER_INVALID")
    if structure_issues(record["fields"]):
        raise ValueError("RAW_ZONE_STRUCTURE_CONFLICT")
    return record


def matches_cell_format(text, spec):
    match = NUMBER.fullmatch(text)
    if not match:
        return False
    value_format = spec.get("value_format")
    return value_format is None or (":" in match[1]) == (value_format == "clock")


def recover_temperature_time_cells(engine, image, meta, lines, profile_id):
    import cv2
    definition = temperature_time_package(profile_id)["raw_field_definition"]
    result = list(lines)
    height, width = image.shape[:2]
    for spec in definition["fields"]:
        region = spec.get("region")
        if not region or any(_inside(line, region, [width, height]) and matches_cell_format(line["text"], spec)
                             for line in result):
            continue
        x1, y1, x2, y2 = spec.get("recovery_region", region)
        left, top, right, bottom = int(x1 * width), int(y1 * height), int(x2 * width), int(y2 * height)
        crop = cv2.resize(image[top:bottom, left:right], None, fx=4, fy=4)
        crop = cv2.copyMakeBorder(crop, 30, 30, 70, 70, cv2.BORDER_CONSTANT, value=255)
        raw = engine.ocr(crop, cls=False)
        for points, (text, confidence) in raw[0] or []:
            if not matches_cell_format(text, spec):
                continue
            xs, ys = zip(*points)
            result.append({"text": text, "conf": float(confidence),
                           "bbox": {"x_min": left + (min(xs) - 70) / 4, "y_min": top + (min(ys) - 30) / 4,
                                    "x_max": left + (max(xs) - 70) / 4, "y_max": top + (max(ys) - 30) / 4},
                           "evidence_method": "cell_ocr_scaled", "scale": 4, "padding": [70, 30]})
    return result


def observe_temperature_time_page(profile_id, lines, meta, image_sha256, rectified_image=None):
    if profile_id == HOLDING_PROFILE:
        from raw_page import observe_raw_page
        return observe_raw_page(profile_id, lines, meta, image_sha256, rectified_image)
    if not re.fullmatch(r"[0-9a-f]{64}", image_sha256):
        raise ValueError("IMAGE_HASH_INVALID")
    from extract_families.coordinates import project_boxes

    package = temperature_time_package(profile_id)
    definition, size = package["raw_field_definition"], meta["screen_size"]
    fields, issues = [], []
    headers = []
    for zone in definition.get("zones", []):
        matches = [line for line in lines if re.sub(r"\s+", "", line["text"]) in zone["labels"]
                   and _inside(line, definition["header_region"], size)]
        for line in matches:
            headers.append((zone, line))
    if definition.get("zones"):
        known_labels = {label for zone in definition["zones"] for label in zone["labels"]}
        for line in lines:
            text = re.sub(r"\s+", "", line["text"])
            if (re.fullmatch(r"(?:区|喷嘴|喷)\d+", text) and text not in known_labels
                    and _inside(line, definition["header_region"], size)):
                issues.append({"code": "ZONE_ID_UNSUPPORTED", "original_label": line["text"],
                               "bbox": _line_box(line), "coordinate_space": "rectified_pixels"})
    headers.sort(key=lambda pair: _line_box(pair[1])[0])
    for spec in definition["fields"]:
        zone_headers = [(index + 1, line) for index, (zone, line) in enumerate(headers)
                        if zone["zone_id"] == spec.get("zone_id")] if spec.get("zone_id") else [(None, None)]
        for order, header in zone_headers:
            labels = [line for line in lines if _inside(line, spec["label_region"], size)
                      and any(label in re.sub(r"\s+", "", line["text"]) for label in spec["labels"])]
            candidates = []
            if header is not None and len(labels) == 1:
                hb, lb = _line_box(header), _line_box(labels[0])
                hx, ly = (hb[0] + hb[2]) / 2, (lb[1] + lb[3]) / 2
                candidates = [line for line in lines if NUMBER.fullmatch(line["text"])
                              and abs((_line_box(line)[0] + _line_box(line)[2]) / 2 - hx) < size[0] * .045
                              and abs((_line_box(line)[1] + _line_box(line)[3]) / 2 - ly) < size[1] * .022]
            elif spec.get("region"):
                candidates = [line for line in lines if matches_cell_format(line["text"], spec)
                              and _inside(line, spec["region"], size)]
            source = candidates[0] if len(candidates) == 1 else None
            match = NUMBER.fullmatch(source["text"]) if source else None
            value = (match[1] if ":" in match[1] else float(match[1])) if match else None
            unit = match[2] if match else None
            label_text = " ".join(line["text"] for line in labels) or None
            if unit is None and label_text:
                unit = next((u for u in ("°F", "°C", "℃", "ms", "min", "s")
                             if u in label_text), None)
            confidence = source.get("conf", source.get("confidence", 0)) if source else None
            reading = ("conflict" if len(candidates) > 1 or len(labels) > 1 else "missing" if not source
                       else "uncertain" if confidence < .9 or not labels else "known")
            field = {key: spec[key] for key in ("screen_field_key", "role", "section", "zone_id", "zone_source", "time_kind") if key in spec}
            field.update(source="image_recognition", original_label=label_text, original_value=value,
                         original_unit=unit, effective_unit=unit or spec["unit"],
                         state="unknown", reading=reading, order=order,
                         text=source["text"] if source else None, confidence=confidence,
                         bbox=_line_box(source) if source else None, original_bbox=None, reasons=[],
                         template_ref={"profile_id": profile_id, "version": VERSION,
                                       "sha256": package["raw_field_definition_sha256"],
                                       "unit": spec["unit"] if unit is None else None})
            if header:
                field["zone_label"] = header["text"]
            if reading != "known":
                issues.append({"code": "READING_" + reading.upper(), "screen_field_key": spec["screen_field_key"]})
            if unit and unit.replace("℃", "°C") != spec["unit"]:
                issues.append({"code": "UNIT_TEMPLATE_CONFLICT", "screen_field_key": spec["screen_field_key"]})
            fields.append(field)
    issues.extend(structure_issues(fields))
    if definition.get("zones") and not headers:
        issues.append({"code": "ZONE_HEADERS_NOT_OBSERVED"})
    project_boxes(fields, meta)
    for field in fields:
        if field["original_bbox"] is None:
            field["reasons"].append("source_box_unavailable")
    transform = copy.deepcopy(meta)
    transform.update(rectifier_input_sha256=meta.get("original_sha256"), original_sha256=image_sha256)
    return {"schema_version": "page_observations.v2", "profile_id": profile_id,
            "source": "image_recognition", "page_identity": definition["page_identity"],
            "image_sha256": image_sha256, "original_size": meta.get("original_size"),
            "coordinate_space": "original_percent", "transform": transform,
            "raw_contract_sha256": package["raw_contract_sha256"],
            "raw_field_definition_sha256": package["raw_field_definition_sha256"],
            "raw_field_definition_version": VERSION, "recognizer": package["recognizer"],
            "package_sha256": content_hash(package), "fields": fields, "issues": issues,
            "ocr_evidence": {"coordinate_space": "rectified_pixels", "screen_size": size, "lines": lines},
            "coverage": {"status": "partial" if issues else "complete", "declared": len(fields),
                         "known": sum(field["reading"] == "known" for field in fields),
                         "observed_zone_ids": list(dict.fromkeys(zone["zone_id"] for zone, _ in headers))}}
