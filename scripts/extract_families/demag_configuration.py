"""Physical readings on the verified DEMAG machine-configuration overview."""

import json
import re
from pathlib import Path

import cv2
import numpy as np

from raw_page import _inside, _line_box
from extract_families.coordinates import project_boxes

PROFILE = "demag.injection_metering.machine_configuration"
DEFINITION = Path(__file__).resolve().parents[2] / "contracts/raw-pages/demag-configuration-1.0.0.json"
NUMBER = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*(mm/s|bar_spez|bar|mm|℃|°C|°F|s)?\s*$")


def extract_configuration(lines, template, meta):
    definition = json.loads(DEFINITION.read_text())
    size = meta.get("screen_size")
    if template.get("profile_id") != PROFILE or not size:
        return dict(fields=None, heater_columns=0, warnings=["CONFIGURATION_IDENTITY_INVALID"], detail={})
    anchors = definition["layout_anchors"]
    if not all(any(re.fullmatch(anchor, line["text"].strip()) for line in lines) for anchor in anchors):
        return dict(fields=None, heater_columns=0, warnings=["CONFIGURATION_LAYOUT_UNVERIFIED"], detail={})
    references, observed = [], []
    for anchor in definition["coordinate_anchors"]:
        matches = [line for line in lines if re.fullmatch(anchor["text"], line["text"].strip())
                   and _inside(line, anchor["search_region"], size)]
        if len(matches) != 1:
            return dict(fields=None, heater_columns=0, warnings=["CONFIGURATION_ANCHOR_CONFLICT"], detail={})
        box = _line_box(matches[0])
        observed.append([(box[0] + box[2]) / (2 * size[0]), (box[1] + box[3]) / (2 * size[1])])
        references.append(anchor["center"])
    matrix = cv2.getAffineTransform(np.float32(observed), np.float32(references))
    if np.linalg.det(matrix[:, :2]) <= .2:
        return dict(fields=None, heater_columns=0, warnings=["CONFIGURATION_GEOMETRY_CONFLICT"], detail={})
    aligned = []
    for line in lines:
        box = _line_box(line)
        x, y = matrix @ np.array([(box[0] + box[2]) / (2 * size[0]),
                                  (box[1] + box[3]) / (2 * size[1]), 1])
        aligned.append({**line, "bbox": [x, y, x, y]})
    fields, issues = [], list(definition["issues"])
    for spec in definition["fields"]:
        candidates = [(index, line) for index, line in enumerate(lines)
                      if spec.get("reading_support") != "unsupported"
                      and _inside(aligned[index], spec["region"], [1, 1]) and NUMBER.fullmatch(line["text"])]
        source = candidates[0][1] if len(candidates) == 1 else None
        match = NUMBER.fullmatch(source["text"]) if source else None
        labels = [line["text"] for index, line in enumerate(lines)
                  if _inside(aligned[index], spec["label_region"], [1, 1])]
        order = spec.get("order")
        if spec.get("zone_id"):
            header_matches = []
            for zone in definition["zones"]:
                for index, line in enumerate(lines):
                    if (re.sub(r"\s+", "", line["text"]) in zone["labels"]
                            and _inside(aligned[index], [0, .67, 1, .74], [1, 1])):
                        header_matches.append((zone["zone_id"], index))
            header_matches.sort(key=lambda pair: _line_box(lines[pair[1]])[0])
            heads = [(min(range(len(definition["temperature_slots"])), key=lambda slot:
                          abs(_line_box(aligned[index])[0] - definition["temperature_slots"][slot])) + 1, index)
                     for zone, index in header_matches if zone == spec["zone_id"]]
            row_labels = [line for index, line in enumerate(lines)
                          if _inside(aligned[index], [0, .72, .2, .81], [1, 1])
                          and line["text"].startswith("实际" if spec["role"] == "actual" else "设定")]
            candidates, labels = [], [line["text"] for line in row_labels]
            if len(heads) == len(row_labels) == 1:
                order, index = heads[0]
                head, row = _line_box(lines[index]), _line_box(row_labels[0])
                for index, line in enumerate(lines):
                    box = _line_box(line)
                    if (NUMBER.fullmatch(line["text"])
                            and abs((box[0] + box[2] - head[0] - head[2]) / (2 * size[0])) < .025
                            and abs((box[1] + box[3] - head[1] - head[3] - row[1] - row[3])
                                    / (2 * size[1]) + observed[2][1]) < .012):
                        candidates.append((index, line))
            elif len(heads) > 1:
                issues.append(dict(code="ZONE_IDENTITY_CONFLICT", zone_id=spec["zone_id"]))
            source = candidates[0][1] if len(candidates) == 1 else None
            match = NUMBER.fullmatch(source["text"]) if source else None
        if spec.get("reading_support") == "unsupported":
            labels = []
        unit = match[2] if match else None
        if unit is None:
            units = [found[0] for label in labels for found in
                     re.finditer(r"(?<![a-z_])(mm/s|bar(?:[ _]spez)?|mm|℃|°C|°F|s)(?![a-z_])", label)]
            unit = units[0] if len(set(units)) == 1 else None
        confidence = source.get("conf", source.get("confidence", 0)) if source else None
        reading = ("unsupported" if spec.get("reading_support") == "unsupported" else
                   "conflict" if len(candidates) > 1 else "missing" if source is None else
                   "uncertain" if confidence < .9 else "known")
        if reading == "known" and spec.get("decimal_places") is not None:
            places = len(match[1].split(".")[1]) if "." in match[1] else 0
            if places != spec["decimal_places"]:
                reading = "uncertain"
                issues.append(dict(code="DISPLAY_PRECISION_UNVERIFIED", screen_field_key=spec["screen_field_key"]))
        if reading != "unsupported" and unit is not None and unit.replace("℃", "°C") != spec["unit"]:
            reading = "conflict"
            issues.append(dict(code="UNIT_TEMPLATE_CONFLICT", screen_field_key=spec["screen_field_key"]))
        field = {key: spec[key] for key in ("screen_field_key", "section", "role", "zone_id",
                                           "zone_source", "order", "time_kind") if key in spec}
        field.update(source="image_recognition", original_label=" ".join(labels) or None,
                     original_value=float(match[1]) if match else None, original_unit=unit,
                     effective_unit=unit or spec["unit"], state="unknown", reading=reading,
                     text=source["text"] if source else None, confidence=confidence,
                     bbox=_line_box(source) if source else None, original_bbox=None,
                     line_indexes=[index for index, _ in candidates], reasons=["enable_state_unverified"])
        if spec.get("zone_id"):
            field["order"] = order
            field["zone_label"] = lines[heads[0][1]]["text"] if len(heads) == 1 else None
        if reading != "known":
            issues.append(dict(code="READING_" + reading.upper(), screen_field_key=spec["screen_field_key"]))
        fields.append(field)
    project_boxes(fields, meta)
    for field in fields:
        if field["original_bbox"] is None:
            field["reasons"].append("source_box_unavailable")
    return dict(fields={}, heater_columns=5, warnings=["RAW_SCREEN_REVIEW_REQUIRED"], detail=dict(
        page_variant="machine_configuration",
        page_observations=dict(profile_id=PROFILE, fields=fields, issues=issues,
                               coverage=dict(status="partial", declared=len(fields),
                                             known=sum(field["reading"] == "known" for field in fields)))))
