"""FANUC's reviewed five-column temperature page, with conservative OCR evidence."""

import copy
import hashlib
import json
import re
from pathlib import Path

from raw_contract import canonical_hash, import_raw_package
from raw_page import _line_box
from extract_families.coordinates import project_boxes
from extract_families.fanuc import _split_nums

ROOT = Path(__file__).resolve().parents[1]
PROFILE = "fanuc.temperature.rightmost5"
VERSION = "0.6.0"
FILES = ("scripts/raw_fanuc_temperature.py", "scripts/extract_families/fanuc.py",
         "scripts/raw_contract.py", "scripts/raw_page.py", "scripts/quality.py",
         "scripts/extract_families/coordinates.py")


def build_fanuc_temperature_package(root=ROOT, *, template=None, samples=None):
    definition = json.loads((root / "contracts/raw-pages/fanuc-temperature-0.6.0.json").read_text())
    configured = json.loads((root / "templates/fanuc/temperature.json").read_text())
    if template is not None and template != configured:
        raise ValueError("FANUC_FROZEN_TEMPLATE_REQUIRED")
    template = configured
    frozen_samples = copy.deepcopy(definition["samples"])
    for sample in frozen_samples:
        path = root / sample["manifest"]["ocr_fixture"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != sample["manifest"]["ocr_sha256"]:
            raise ValueError("FANUC_FROZEN_OCR_REQUIRED")
        sample["ocr"] = json.loads(path.read_text())
        sample["ocr_content_sha256"] = hashlib.sha256(json.dumps(sample["ocr"], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    if samples is not None and samples != frozen_samples:
        raise ValueError("FANUC_FROZEN_SAMPLES_REQUIRED")
    contract = json.loads((root / "contracts/page_observations.v2.schema.json").read_text())
    sources = {path: (ROOT / path).read_text() for path in FILES}
    files = {path: hashlib.sha256(source.encode()).hexdigest() for path, source in sources.items()}
    return dict(package_schema="hmi_raw_page_package.v2", profile_id=PROFILE, version=VERSION,
                template=template, raw_contract=contract, raw_contract_sha256=canonical_hash(contract),
                raw_field_definition=definition, raw_field_definition_sha256=canonical_hash(definition),
                samples=frozen_samples, recognizer=dict(id="fanuc.temperature.v2", files=files,
                sources=sources, sha256=canonical_hash(files)))


def fanuc_temperature_package(root=ROOT, version=VERSION):
    if version != VERSION:
        raise ValueError("RAW_PAGE_VERSION_UNSUPPORTED")
    package = import_raw_package(json.loads((Path(root) / "templates/packages" / PROFILE / f"{version}.json").read_text()))
    if package != build_fanuc_temperature_package(Path(root)):
        raise ValueError("RAW_PACKAGE_FROZEN_CONTENT_MISMATCH")
    return package


def trial_fanuc_temperature(template, samples):
    build_fanuc_temperature_package(template=template, samples=samples)
    results = []
    for sample in samples:
        record = observe_fanuc_temperature(sample["ocr"]["lines"], sample["rectification"],
                                           sample["manifest"]["original_sha256"])
        record["engine"] = sample["ocr"]["engine"]
        results.append(dict(sample_id=sample["manifest"]["sample_id"], result=dict(
            fields=None, warnings=["RAW_REVIEW_REQUIRED"], detail=dict(page_observations=record))))
    return results


def observe_fanuc_temperature(lines, meta, image_sha256, root=ROOT, version=VERSION):
    if not re.fullmatch(r"[a-f0-9]{64}", image_sha256):
        raise ValueError("IMAGE_HASH_INVALID")
    package = fanuc_temperature_package(root, version)
    definition = package["raw_field_definition"]
    width, height = meta["screen_size"]
    tokens = [dict(line=line, text=line["text"], x=sum(_line_box(line)[::2]) / (2 * width),
                   y=sum(_line_box(line)[1::2]) / (2 * height)) for line in lines]
    for token in tokens:
        match = re.fullmatch(r"\s*([+-]?\d+(?:\.\d+)?)\s*(?:°C|°F|°℃|℃)?\s*", token["text"])
        token["verbatim_numeric"] = match is not None
        token["numbers"] = [float(match[1])] if match else _split_nums(token["text"])
    anchors = {row: [t for t in tokens if t["text"].strip() == label and t["x"] < .25]
               for row, label in definition["rows"].items()}
    zones = definition["zones"]
    order = [z["zone_id"] for z in zones]
    headers = []
    current = anchors["actual"]
    if len(current) == 1:
        for t in tokens:
            matches = [z for z in zones if t["text"].strip().upper() in z["labels"]]
            if matches and .25 < t["x"] < .8 and current[0]["y"] - .095 < t["y"] < current[0]["y"] - .015:
                headers.append((matches[0]["zone_id"], t))
    issues = []
    if len({z for z, _ in headers}) != len(headers):
        issues.append(dict(code="ZONE_IDENTITY_CONFLICT"))
    complete_headers = len(headers) == len(zones) and len({z for z, _ in headers}) == len(zones)
    if complete_headers:
        order = [z for z, _ in sorted(headers, key=lambda pair: pair[1]["x"])]
    elif headers:
        observed = [z for z, _ in sorted(headers, key=lambda pair: pair[1]["x"])]
        if observed != [z for z in order if z in observed]:
            issues.append(dict(code="ZONE_HEADER_ORDER_UNRESOLVED"))
    rows = {}
    for row, labels in anchors.items():
        values = []
        if len(labels) == 1:
            label = labels[0]
            band = [t for t in tokens if .14 < t["x"] < .8 and abs(t["y"] - label["y"]) < .022]
            for t in sorted(band, key=lambda t: t["x"]):
                values.extend((value, t, len(t["numbers"])) for value in t["numbers"])
        expected = 5 if row == "actual" else 9
        if len(values) != expected:
            issues.append(dict(code="TEMPERATURE_ROW_CARDINALITY_CONFLICT", row=row,
                               observed=len(values), expected=expected))
            rows[row] = {}
        else:
            rows[row] = dict(zip(order, values[-5:]))
    fields = []
    for spec in definition["fields"]:
        value, source, merged = None, None, 0
        labels = anchors.get(spec.get("row"), [])
        state, state_evidence = "unknown", None
        if spec.get("zone_id"):
            entry = rows[spec["row"]].get(spec["zone_id"])
            if entry:
                value, source, merged = entry
        else:
            labels = [t for t in tokens if t["text"].strip() == "低温保持" and t["x"] < .55 and t["y"] < .3]
            if len(labels) == 1:
                label = labels[0]
                switches = [t for t in tokens if t["text"].strip() in ("ON", "OFF")
                            and 0 < t["x"] - label["x"] < .22 and abs(t["y"] - label["y"]) < .025]
                if len(switches) == 1:
                    switch = switches[0]
                    state_evidence = dict(text=switch["text"], bbox=_line_box(switch["line"]),
                                          original_bbox=None, coordinate_space="rectified_pixels",
                                          confidence=switch["line"].get("conf", switch["line"].get("confidence", 0)))
                    if state_evidence["confidence"] >= .9:
                        state = "disabled" if switch["text"] == "OFF" else "enabled"
                    candidates = [t for t in tokens if abs(t["x"] - switch["x"]) < .05
                                  and .015 < t["y"] - switch["y"] < .065 and len(t["numbers"]) == 1]
                    if len(candidates) == 1:
                        source = candidates[0]
                        value = source["numbers"][0]
                        merged = 1
        confidence = source["line"].get("conf", source["line"].get("confidence", 0)) if source else None
        unit_match = re.search(r"°℃|°C|℃|°F", source["text"]) if source else None
        unit = unit_match[0] if unit_match else None
        reading = ("missing" if source is None else "uncertain"
                   if confidence < .9 or merged > 1 or not source["verbatim_numeric"] else "known")
        if any(i["code"] in ("ZONE_IDENTITY_CONFLICT", "ZONE_HEADER_ORDER_UNRESOLVED") for i in issues) and spec.get("zone_id"):
            reading = "conflict"
        field = {key: spec[key] for key in ("screen_field_key", "section", "role", "zone_id", "zone_source") if key in spec}
        field.update(source="image_recognition", original_label=labels[0]["text"] if len(labels) == 1 else None,
                     original_value=value, original_unit=unit, effective_unit=unit or spec["unit"],
                     state=state, reading=reading, confidence=confidence,
                     text=source["text"] if source else None, bbox=_line_box(source["line"]) if source else None,
                     original_bbox=None, reasons=["shared_ocr_box"] if merged > 1 else [],
                     template_ref=dict(profile_id=PROFILE, version=version,
                        sha256=package["raw_field_definition_sha256"], unit=spec["unit"] if unit is None else None))
        if spec.get("zone_id"):
            field["order"] = order.index(spec["zone_id"]) + 1
        if state_evidence:
            field["state_evidence"] = state_evidence
            project_boxes([state_evidence], meta)
        if unit and unit.replace("℃", "°C") != spec["unit"]:
            issues.append(dict(code="UNIT_TEMPLATE_CONFLICT", screen_field_key=spec["screen_field_key"]))
        if reading != "known":
            issues.append(dict(code="READING_" + reading.upper(), screen_field_key=spec["screen_field_key"]))
        fields.append(field)
    project_boxes(fields, meta)
    transform = copy.deepcopy(meta)
    transform.update(rectifier_input_sha256=meta.get("original_sha256"), original_sha256=image_sha256)
    return dict(schema_version="page_observations.v2", source="image_recognition", profile_id=PROFILE,
                page_identity=definition["page_identity"], image_sha256=image_sha256,
                original_size=meta.get("original_size"), coordinate_space="original_percent", transform=transform,
                raw_contract_sha256=package["raw_contract_sha256"], raw_field_definition_version=version,
                raw_field_definition_sha256=package["raw_field_definition_sha256"], package_sha256=canonical_hash(package),
                recognizer=package["recognizer"], fields=fields, issues=issues,
                ocr_evidence=dict(lines=lines, coordinate_space="rectified_pixels", screen_size=meta["screen_size"]),
                coverage=dict(status="partial" if issues else "complete", declared=len(fields),
                              known=sum(f["reading"] == "known" for f in fields)))
