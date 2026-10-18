"""Offline integrity and semantic checks for original-screen packages."""

import hashlib
import json
import math
from datetime import datetime


def canonical_hash(document):
    return hashlib.sha256(json.dumps(document, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def import_raw_package(document):
    package = json.loads(json.dumps(document, allow_nan=False))
    if package.get("package_schema") != "hmi_raw_page_package.v2":
        raise ValueError("RAW_PACKAGE_SCHEMA_UNSUPPORTED")
    for key in ("raw_contract", "raw_field_definition"):
        if canonical_hash(package[key]) != package[key + "_sha256"]:
            raise ValueError("RAW_PACKAGE_HASH_MISMATCH")
    definition = package["raw_field_definition"]
    if definition["profile_id"] != package["profile_id"] or definition["version"] != package["version"]:
        raise ValueError("RAW_PACKAGE_IDENTITY_MISMATCH")
    keys = [field["screen_field_key"] for field in definition["fields"]]
    if not keys or len(keys) != len(set(keys)):
        raise ValueError("RAW_FIELD_IDENTITY_CONFLICT")
    return package


def validate_raw_record(record, package):
    definition = import_raw_package(package)["raw_field_definition"]
    if record.get("schema_version") != "page_observations.v2":
        raise ValueError("RAW_CONTRACT_VERSION_UNSUPPORTED")
    required = {"source", "profile_id", "fields", "raw_field_definition_sha256"}
    if not required <= record.keys():
        raise ValueError("RAW_RECORD_INCOMPLETE")
    if (record.get("profile_id") != package["profile_id"] or
            record.get("raw_field_definition_sha256") != package["raw_field_definition_sha256"]):
        raise ValueError("RAW_DEFINITION_MISMATCH")
    source = record.get("source")
    if source == "image_recognition":
        if not {"original_size", "recognizer", "package_sha256", "raw_contract_sha256", "engine"} <= record.keys():
            raise ValueError("IMAGE_PROVENANCE_REQUIRED")
        image_hash = record.get("image_sha256", "")
        if len(image_hash) != 64 or any(char not in "0123456789abcdef" for char in image_hash):
            raise ValueError("IMAGE_HASH_INVALID")
        if record.get("raw_contract_sha256") != package["raw_contract_sha256"]:
            raise ValueError("RAW_CONTRACT_HASH_MISMATCH")
        if record["recognizer"] != package["recognizer"] or record["package_sha256"] != canonical_hash(package):
            raise ValueError("RAW_PACKAGE_HASH_MISMATCH")
        size = record["original_size"]
        if not isinstance(size, list) or len(size) != 2 or not all(type(x) is int and 1 <= x <= 100000 for x in size):
            raise ValueError("IMAGE_DIMENSIONS_INVALID")
    elif source == "manual":
        if not isinstance(record.get("actor"), str) or not record["actor"].strip() or type(record.get("revision")) is not int or record["revision"] < 1:
            raise ValueError("MANUAL_AUDIT_REQUIRED")
        datetime.fromisoformat(record["created_at"].replace("Z", "+00:00"))
        if "image_sha256" in record or "recognizer" in record:
            raise ValueError("MANUAL_RECOGNITION_EVIDENCE_FORBIDDEN")
        if "image_reference" in record:
            reference = record["image_reference"]
            if (not isinstance(reference, dict) or set(reference) != {"sha256"} or
                    not isinstance(reference["sha256"], str) or len(reference["sha256"]) != 64 or
                    any(char not in "0123456789abcdef" for char in reference["sha256"])):
                raise ValueError("MANUAL_IMAGE_REFERENCE_INVALID")
    else:
        raise ValueError("RAW_SOURCE_UNSUPPORTED")
    specs = {field["screen_field_key"]: field for field in definition["fields"]}
    seen = set()
    if not isinstance(record["fields"], list) or len(record["fields"]) > 1000:
        raise ValueError("RAW_FIELDS_INVALID")
    for field in record["fields"]:
        if not {"screen_field_key", "source", "original_label", "original_value", "original_unit",
                "role", "state", "reading", "original_bbox"} <= field.keys():
            raise ValueError("RAW_FIELD_INCOMPLETE")
        key = field["screen_field_key"]
        if key not in specs or key in seen:
            raise ValueError("RAW_FIELD_IDENTITY_CONFLICT")
        seen.add(key)
        if field.get("source", source) != source:
            raise ValueError("RAW_SOURCE_CONFLICT")
        for name, limit in (("original_label", 512), ("original_unit", 32)):
            if field[name] is not None and (not isinstance(field[name], str) or len(field[name]) > limit):
                raise ValueError("RAW_TEXT_INVALID")
        if (field["role"] not in ("setting", "actual", "unknown") or
                field["state"] not in ("enabled", "disabled", "unknown") or
                field["reading"] not in ("known", "missing", "uncertain", "unsupported", "conflict")):
            raise ValueError("RAW_STATE_INVALID")
        value = field["original_value"]
        if value is not None and type(value) not in (str, int, float, bool):
            raise ValueError("RAW_VALUE_INVALID")
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("RAW_VALUE_INVALID")
        if isinstance(value, str) and len(value) > 2048:
            raise ValueError("RAW_VALUE_TOO_LONG")
        if field["reading"] == "known" and value is None:
            raise ValueError("RAW_READING_CONFLICT")
        confidence = field.get("confidence")
        if confidence is not None and (type(confidence) not in (float, int) or not math.isfinite(confidence) or not 0 <= confidence <= 1):
            raise ValueError("RAW_CONFIDENCE_INVALID")
        if source == "manual" and any(field.get(key) is not None for key in
                                      ("confidence", "bbox", "original_bbox", "text")):
            raise ValueError("MANUAL_RECOGNITION_EVIDENCE_FORBIDDEN")
        box = field.get("original_bbox")
        if box is not None and (not isinstance(box, list) or len(box) != 4 or not all(type(x) in (int, float) and math.isfinite(x) for x in box)
                                or not 0 <= box[0] < box[2] <= 100 or not 0 <= box[1] < box[3] <= 100):
            raise ValueError("RAW_BOX_INVALID")
    if source == "image_recognition" and seen != set(specs):
        raise ValueError("RAW_FIELD_COVERAGE_INCOMPLETE")
    return record
