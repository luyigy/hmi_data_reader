"""Physical SELOGICA two-stage feed/decompression observations."""

import json
import re
from pathlib import Path

from raw_page import _inside, _line_box
from extract_families.coordinates import project_boxes

PROFILE = "arburg.storage_cooling.selogica_two_stage"
DEFINITION = Path(__file__).resolve().parents[2] / "contracts/raw-pages/arburg-selogica-metering-1.0.0.json"
NUMBER = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*(mm/s|bar|mm|s)?\s*$", re.I)


def extract_selogica(lines, template, meta):
    size = meta.get("screen_size")
    if template.get("profile_id") != PROFILE or not size:
        return dict(fields=None, heater_columns=0, warnings=["SELOGICA_IDENTITY_INVALID"], detail={})
    definition = json.loads(DEFINITION.read_text())
    labels = [(line, re.sub(r"[\s:：]", "", line["text"])) for line in lines]
    cooling = [line for line, text in labels if text == "剩余冷却时间"]
    after = [line for line, text in labels if text == "进料后"]
    if len(cooling) != 1 or len(after) != 1:
        return dict(fields=None, heater_columns=0, warnings=["SELOGICA_LAYOUT_UNVERIFIED"], detail={})
    c, a = _line_box(cooling[0]), _line_box(after[0])
    cy, ay = (c[1] + c[3]) / (2 * size[1]), (a[1] + a[3]) / (2 * size[1])
    sx, sy = a[0] / size[0] / .525, (ay - cy) / (.660 - .323)
    if not .65 < sx < 1.6 or not .7 < sy < 1.3:
        return dict(fields=None, heater_columns=0, warnings=["SELOGICA_LAYOUT_CONFLICT"], detail={})
    fields, issues = [], []
    for spec in definition["fields"]:
        x1, y1, x2, y2 = spec["region"]
        region = [x1 * sx, cy + (y1 - .323) * sy, x2 * sx, cy + (y2 - .323) * sy]
        candidates = [line for line in lines if _inside(line, region, size) and NUMBER.fullmatch(line["text"])]
        source = candidates[0] if len(candidates) == 1 else None
        match = NUMBER.fullmatch(source["text"]) if source else None
        confidence = source.get("conf", source.get("confidence", 0)) if source else None
        unit = match[2] if match else None
        if not unit and spec.get("unit_region"):
            u1, v1, u2, v2 = spec["unit_region"]
            ur = [u1 * sx, cy + (v1 - .323) * sy, u2 * sx, cy + (v2 - .323) * sy]
            units = {line["text"].strip() for line in lines if _inside(line, ur, size)
                     and line["text"].strip() in ("mm/s", "bar", "mm", "s")}
            unit = next(iter(units)) if len(units) == 1 else None
        reading = "conflict" if len(candidates) > 1 else "missing" if source is None else "uncertain" if confidence < .9 else "known"
        reasons = ["enable_state_unverified"]
        if spec["role"] == "unknown":
            reasons.append("role_unverified")
        if unit is not None and unit != spec["unit"]:
            reading = "conflict"
            reasons.append("unit_template_conflict")
        if spec.get("reading_support") == "unsupported":
            reading = "unsupported"
        if unit is None and spec["unit"] is not None:
            reasons.append("unit_from_definition")
        field = {key: spec[key] for key in ("screen_field_key", "role", "section", "stage", "segment_id", "order", "time_kind") if key in spec}
        field.update(source="image_recognition", original_label=None,
                     original_value=float(match[1]) if match else None,
                     original_unit=unit, effective_unit=unit or spec["unit"],
                     state="unknown", reading=reading, reasons=reasons,
                     text=source["text"] if source else None, confidence=confidence,
                     bbox=_line_box(source) if source else None, original_bbox=None)
        if spec["screen_field_key"] == "time.remaining_cooling":
            field["original_label"] = cooling[0]["text"]
        if reading != "known":
            issues.append(dict(code="READING_" + reading.upper(), screen_field_key=spec["screen_field_key"]))
        fields.append(field)
    project_boxes(fields, meta)
    for field in fields:
        if field["original_bbox"] is None:
            field["reasons"].append("source_box_unavailable")
    return dict(fields={}, heater_columns=0, warnings=["RAW_SCREEN_REVIEW_REQUIRED"], detail=dict(
        page_observations=dict(profile_id=PROFILE, fields=fields, issues=issues,
                               coverage=dict(status="partial", declared=len(fields), known=sum(f["reading"] == "known" for f in fields)))))
