"""Pinned YIZUMI F2 original-screen readings, without business projection."""

import copy
import hashlib
import json
import math
import re
from pathlib import Path

from raw_contract import canonical_hash, import_raw_package
from raw_page import _inside, _line_box
from extract_families.coordinates import project_boxes

ROOT = Path(__file__).resolve().parents[1]
PROFILE = "yizumi.injection_metering.injection_holding_f2"
VERSION = "1.0.1"
DEFINITION = "contracts/raw-pages/yizumi-injection-f2-1.0.0.json"
FILES = ("scripts/raw_yizumi.py", "scripts/raw_contract.py", "scripts/raw_page.py",
         "scripts/extract_families/coordinates.py", DEFINITION)
NUMBER = re.compile(r"^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-zA-Z%°/]+)?\s*$")
STAGES = {"一段": 1, "二段": 2, "三段": 3, "四段": 4, "五段": 5, "六段": 6}


def matches_yizumi_layout(lines, definition=None):
    definition = definition or json.loads((ROOT / DEFINITION).read_text())
    texts = {line["text"].strip().casefold() for line in lines}
    return {text.casefold() for text in definition["anchors"]} <= texts


def _alignment(lines, size, definition):
    def center(line):
        x1, y1, x2, y2 = _line_box(line)
        return (x1 + x2) / (2 * size[0]), (y1 + y2) / (2 * size[1])

    markers = {}
    for text in ("射胶", "切保压", "保压"):
        found = [(index, line) for index, line in enumerate(lines)
                 if line["text"].strip() == text and .2 < center(line)[0] < .6]
        if len(found) != 1:
            raise ValueError("RAW_PAGE_LAYOUT_CONFLICT")
        markers[text] = found[0]
    counts = [(index, line) for index, line in enumerate(lines)
              if line["text"].strip() == "段数" and center(line)[0] > .65]
    counts.sort(key=lambda item: center(item[1])[1])
    if not counts or len(counts) > 1 and abs(center(counts[0][1])[1] - center(counts[1][1])[1]) < .015:
        raise ValueError("RAW_PAGE_LAYOUT_CONFLICT")
    reference = definition["alignment"]
    injection, holding, count = center(markers["射胶"][1]), center(markers["保压"][1]), center(counts[0][1])
    sx = (count[0] - injection[0]) / (reference["count"][0] - reference["injection"][0])
    sy = (holding[1] - injection[1]) / (reference["holding"][1] - reference["injection"][1])
    ox, oy = injection[0] - sx * reference["injection"][0], injection[1] - sy * reference["injection"][1]
    if (not .6 < sx < 1.4 or not .6 < sy < 1.4
            or abs(center(markers["切保压"][1])[1] - (sy * reference["vp"][1] + oy)) > .03):
        raise ValueError("RAW_PAGE_LAYOUT_CONFLICT")
    return sx, sy, ox, oy, [markers[text][0] for text in ("射胶", "切保压", "保压")] + [counts[0][0]]


def build_yizumi_package(template, samples):
    definition = json.loads((ROOT / DEFINITION).read_text())
    expected = {sample["sample_id"]: sample["image_sha256"] for sample in definition["samples"]}
    provided = {sample["manifest"]["sample_id"]: sample["manifest"]["original_sha256"] for sample in samples}
    if (provided != expected or len(samples) != len(expected)
            or len(set(provided.values())) != len(expected)):
        raise ValueError("YIZUMI_FROZEN_SAMPLES_REQUIRED")
    expected_ocr = {sample["sample_id"]: sample["ocr_content_sha256"] for sample in definition["samples"]}
    expected_manifests = {sample["sample_id"]: sample["manifest_sha256"] for sample in definition["samples"]}
    for sample in samples:
        if canonical_hash(sample["manifest"]) != expected_manifests[sample["manifest"]["sample_id"]]:
            raise ValueError("YIZUMI_FROZEN_MANIFEST_MISMATCH")
        digest = hashlib.sha256(json.dumps(sample["ocr"], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if not sample["ocr"].get("lines") or digest != expected_ocr[sample["manifest"]["sample_id"]]:
            raise ValueError("YIZUMI_FROZEN_OCR_MISMATCH")
    if (template["profile_id"] != PROFILE
            or template.get("extractor_id") != "yizumi.injection_holding_f2"
            or any(template.get("page_identity", {}).get(key) != value
                   for key, value in definition["page_identity"].items())):
        raise ValueError("YIZUMI_PACKAGE_IDENTITY_CONFLICT")
    definition["version"] = template["version"]
    contract = json.loads((ROOT / "contracts/page_observations.v2.schema.json").read_text())
    sources = {path: (ROOT / path).read_text() for path in FILES}
    hashes = {path: hashlib.sha256(source.encode()).hexdigest() for path, source in sources.items()}
    return dict(package_schema="hmi_raw_page_package.v2", profile_id=PROFILE,
                version=template["version"], template=template, samples=samples,
                raw_contract=contract, raw_contract_sha256=canonical_hash(contract),
                raw_field_definition=definition, raw_field_definition_sha256=canonical_hash(definition),
                recognizer=dict(id="yizumi_f2_numeric.v2", version=VERSION, files=hashes,
                                sources=sources, sha256=canonical_hash(hashes)))


def yizumi_package(root=ROOT, version=VERSION):
    if not re.fullmatch(r"1\.\d+\.\d+", version):
        raise ValueError("RAW_PAGE_VERSION_UNSUPPORTED")
    package = import_raw_package(json.loads((Path(root) / "templates/packages" / PROFILE /
                                             f"{version}.json").read_text()))
    if (package["profile_id"] != PROFILE or package["version"] != version
            or package["template"]["version"] != version):
        raise ValueError("RAW_PACKAGE_IDENTITY_MISMATCH")
    recognizer = package["recognizer"]
    if recognizer["id"] != "yizumi_f2_numeric.v2" or set(recognizer["files"]) != set(FILES):
        raise ValueError("RAW_RECOGNIZER_UNSUPPORTED")
    actual = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in FILES}
    embedded = {path: hashlib.sha256(recognizer["sources"][path].encode()).hexdigest() for path in FILES}
    if actual != recognizer["files"] or embedded != actual or canonical_hash(actual) != recognizer["sha256"]:
        raise ValueError("RAW_RECOGNIZER_HASH_MISMATCH")
    if package != build_yizumi_package(package["template"], package["samples"]):
        raise ValueError("RAW_PACKAGE_FROZEN_CONTENT_MISMATCH")
    return package


def observe_yizumi_page(lines, meta, image_sha256, root=ROOT, version=VERSION):
    if not re.fullmatch(r"[a-f0-9]{64}", image_sha256):
        raise ValueError("IMAGE_HASH_INVALID")
    package = yizumi_package(root, version)
    definition, size = package["raw_field_definition"], meta["screen_size"]
    if not matches_yizumi_layout(lines, definition):
        raise ValueError("RAW_PAGE_LAYOUT_CONFLICT")
    sx, sy, ox, oy, alignment_indexes = _alignment(lines, size, definition)

    def mapped(region):
        return [region[0] * sx + ox, region[1] * sy + oy,
                region[2] * sx + ox, region[3] * sy + oy]

    headers, orders, issues = {}, {}, []
    for section, config in definition["stage_headers"].items():
        found = []
        for index, line in enumerate(lines):
            if not _inside(line, mapped(config["region"]), size):
                continue
            names = re.findall(r"[一二三四五六]段", line["text"])
            if not names or "".join(names) != line["text"].strip():
                continue
            box = _line_box(line)
            for offset, name in enumerate(names):
                x = ((box[0] + (box[2] - box[0]) * (offset + .5) / len(names)) / size[0] - ox) / sx
                found.append((STAGES[name], x, index))
        found.sort(key=lambda item: item[1])
        for stage in config["stages"]:
            matches = [(x, index) for candidate, x, index in found if candidate == stage]
            headers[section, stage] = matches
            if len(matches) != 1:
                issues.append(dict(code="STAGE_IDENTITY_CONFLICT" if matches else "STAGE_HEADER_MISSING",
                                   section=section, stage=stage, line_indexes=[index for _, index in matches]))
        if any(stage not in config["stages"] for stage, _, _ in found):
            issues.append(dict(code="STAGE_ID_UNSUPPORTED", section=section))
        orders[section] = {stage: order for order, (stage, _, _) in enumerate(found, 1)}
    row_centers = {}
    for spec in definition["fields"]:
        if spec.get("stage") is not None:
            row_centers.setdefault(spec["section"], set()).add((spec["region"][1] + spec["region"][3]) / 2)
    fields = []
    for spec in definition["fields"]:
        region, reading, order = list(spec["region"]), None, spec.get("order")
        if spec.get("stage") is not None:
            matches = headers[spec["section"], spec["stage"]]
            if len(matches) == 1:
                shift = matches[0][0] - spec["header_x"]
                region[0] += shift
                region[2] += shift
                order = orders[spec["section"]][spec["stage"]]
            else:
                reading = "conflict" if matches else "missing"
        candidates = [(index, line, NUMBER.fullmatch(line["text"]))
                      for index, line in enumerate(lines) if _inside(line, mapped(region), size)
                      and NUMBER.fullmatch(line["text"])] if reading is None else []
        row_bounds = None
        if not candidates and reading is None and spec.get("stage") is not None:
            centers = sorted(row_centers[spec["section"]])
            center = (region[1] + region[3]) / 2
            if len(centers) > 1:
                position = centers.index(center)
                previous = centers[position - 1] if position else 2 * center - centers[1]
                following = centers[position + 1] if position + 1 < len(centers) else 2 * center - centers[-2]
                cell = mapped([region[0], (previous + center) / 2, region[2], (center + following) / 2])
                candidates = []
                for index, line in enumerate(lines):
                    box = _line_box(line)
                    center_y = (box[1] + box[3]) / (2 * size[1])
                    match = NUMBER.fullmatch(line["text"])
                    if (match and _inside(line, cell, size)
                            and not any(math.isclose(center_y, edge) for edge in (cell[1], cell[3]))):
                        candidates.append((index, line, match))
                row_bounds = cell
        chosen = candidates[0] if len(candidates) == 1 else None
        confidence = chosen[1].get("conf", chosen[1].get("confidence")) if chosen else None
        value = float(chosen[2][1]) if chosen else None
        if value is not None and not math.isfinite(value):
            value, reading = None, "uncertain"
        labels = [line["text"] for line in lines if _inside(line, mapped(spec["label_region"]), size)]
        unit = chosen[2][2] if chosen else None
        if unit and unit.lower() == "s":
            unit = "s"
        if unit is None:
            unit_lines = [line["text"].strip() for line in lines
                          if spec.get("unit_region") and _inside(line, mapped(spec["unit_region"]), size)]
            unit = next((text.lower() if text.lower() == "s" else text for text in unit_lines
                         if text.lower() in ("bar", "mm", "mm/s", "s", "%")), None)
        reading = reading or ("conflict" if len(candidates) > 1 else "missing" if not chosen else
                              "uncertain" if confidence is None or confidence < .9 else "known")
        if spec.get("reading_support") == "unsupported":
            value, chosen, confidence, reading = None, None, None, "unsupported"
        if unit is not None and unit != spec["unit"]:
            reading = "conflict"
            issues.append(dict(code="UNIT_TEMPLATE_CONFLICT", screen_field_key=spec["screen_field_key"]))
        field = dict(screen_field_key=spec["screen_field_key"], source="image_recognition",
                     original_label=" ".join(labels) or None, original_value=value, original_unit=unit,
                     label=spec["label"], value=value, unit=unit or spec["unit"], effective_unit=unit or spec["unit"],
                     role=spec["role"], state="unknown", state_basis=None, reading=reading,
                     section=spec["section"], stage=spec.get("stage"), segment_id=spec.get("segment_id"),
                     order=order, text=chosen[1]["text"] if chosen else None, confidence=confidence,
                     bbox=_line_box(chosen[1]) if chosen else None, original_bbox=None,
                     line_indexes=[index for index, _, _ in candidates], reasons=[],
                     template_ref=dict(profile_id=PROFILE, version=version,
                                       sha256=package["raw_field_definition_sha256"],
                                       unit=spec["unit"] if unit is None else None, role=spec["role"]))
        if row_bounds:
            field["reasons"].append("ROW_CELL_MIDPOINT_BOUNDS:" + json.dumps(row_bounds))
        if len(candidates) > 1:
            field["candidates"] = [dict(text=line["text"], bbox=_line_box(line), line_index=index)
                                   for index, line, _ in candidates]
        if reading != "known":
            issues.append(dict(code="READING_" + reading.upper(), screen_field_key=spec["screen_field_key"],
                               reason="Checkbox decoder not verified" if reading == "unsupported" else
                               "OCR or physical-header evidence incomplete or ambiguous"))
        fields.append(field)
    project_boxes(fields, meta)
    transform = copy.deepcopy(meta)
    transform.update(rectifier_input_sha256=meta.get("original_sha256"), original_sha256=image_sha256)
    return dict(schema_version="page_observations.v2", profile_id=PROFILE, source="image_recognition",
                page_identity=definition["page_identity"], image_sha256=image_sha256,
                original_size=meta["original_size"], coordinate_space="original_percent", transform=transform,
                raw_contract_sha256=package["raw_contract_sha256"],
                raw_field_definition_sha256=package["raw_field_definition_sha256"],
                raw_field_definition_version=version, package_sha256=canonical_hash(package),
                recognizer=package["recognizer"], fields=fields, issues=issues,
                layout_alignment=dict(method="ocr_landmarks_affine.v1", scale=[sx, sy], offset=[ox, oy],
                                      line_indexes=alignment_indexes, coordinate_space="normalized_rectified"),
                ocr_evidence=dict(coordinate_space="rectified_pixels", screen_size=size, lines=lines),
                coverage=dict(status="partial", declared=len(fields),
                              known=sum(field["reading"] == "known" for field in fields),
                              exclusions=definition["exclusions"]))
