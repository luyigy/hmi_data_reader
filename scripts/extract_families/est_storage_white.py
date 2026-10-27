"""Development-only BOLE white five-stage storage/decompression observations."""

import json
import re
from pathlib import Path

from raw_contract import canonical_hash
from raw_page import _inside, _line_box
from extract_families.coordinates import project_boxes


DEFINITION = Path(__file__).resolve().parents[2] / "contracts/raw-pages/est-storage-white-0.5.0-draft.json"
NUMBER = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*(RPM|bar|mm|%|s)?\s*$")


def est_storage_white_extract(lines, template, meta):
    definition = json.loads(DEFINITION.read_text())
    size = meta.get("screen_size")
    if not size or template.get("profile_id") != definition["profile_id"]:
        return dict(fields=None, heater_columns=0, warnings=["EST_WHITE_IDENTITY_MISMATCH"], detail={})
    anchors = {re.sub(r"\s+", "", line["text"]) for line in lines
               if _inside(line, [.28, .06, .91, .30], size)}
    if not {"储料射退设定", "一段", "二段", "三段", "四段", "五段"} <= anchors:
        return dict(fields=None, heater_columns=0, warnings=["EST_WHITE_LAYOUT_MISMATCH"], detail={})
    headings = [line for line in lines if line["text"] in ("一段", "二段", "三段", "四段", "五段")
                and _inside(line, [.28, .26, .91, .30], size)]
    headings.sort(key=lambda line: _line_box(line)[0])
    if [line["text"] for line in headings] != ["一段", "二段", "三段", "四段", "五段"]:
        return dict(fields=None, heater_columns=0, warnings=["EST_WHITE_STAGE_ORDER_CONFLICT"], detail={})
    if any(not _inside(line, [.32 + index * .123, .26, .42 + index * .123, .30], size)
           for index, line in enumerate(headings)):
        return dict(fields=None, heater_columns=0, warnings=["EST_WHITE_LAYOUT_MISMATCH"], detail={})
    observations = []
    issues = list(definition["issues"])
    for spec in definition["fields"]:
        candidates = [line for line in lines if _inside(line, spec["region"], size)
                      and NUMBER.fullmatch(line["text"])]
        source = candidates[0] if len(candidates) == 1 else None
        match = NUMBER.fullmatch(source["text"]) if source else None
        labels = [line for line in lines if spec.get("label_region")
                  and _inside(line, spec["label_region"], size)
                  and spec["label"] in line["text"]]
        unit = match[2] if match else None
        unit_lines = [line for line in lines if spec.get("unit_region")
                      and _inside(line, spec["unit_region"], size)
                      and line["text"].strip() == spec["unit"] and line.get("conf", 0) >= .9]
        if unit is None and unit_lines:
            unit = spec["unit"]
        confidence = source.get("conf", 0) if source else None
        reading = ("unsupported" if spec.get("reading_support") == "unsupported" else
                   "conflict" if len(candidates) > 1 else "missing" if source is None else
                   "uncertain" if confidence < .9 or spec.get("semantic_status") or
                   spec.get("label") and len(labels) != 1 else "known")
        field = {key: spec[key] for key in ("screen_field_key", "section", "stage", "role", "segment_id", "order")
                 if key in spec}
        field.update(source="image_recognition", original_label=labels[0]["text"] if len(labels) == 1 else None,
                     original_value=float(match[1]) if match else None, original_unit=unit,
                     effective_unit=unit or spec["unit"], state="unknown", reading=reading,
                     text=source["text"] if source else None, confidence=confidence,
                     bbox=_line_box(source) if source else None, original_bbox=None,
                     reasons=["state_unverified"],
                     template_ref={"profile_id": definition["profile_id"], "version": definition["version"],
                                   "sha256": canonical_hash(definition),
                                   "unit": spec["unit"] if unit is None else None})
        if spec.get("semantic_status"):
            field["reasons"].append(spec["semantic_status"])
        if spec.get("reason"):
            field["reasons"].append(spec["reason"])
        if reading != "known":
            issues.append(dict(code="READING_" + reading.upper(), screen_field_key=spec["screen_field_key"]))
        if unit is not None and spec["unit"] is not None and unit != spec["unit"]:
            field["reading"] = "conflict"
            field["reasons"].append("unit_template_conflict")
            issues.append(dict(code="UNIT_TEMPLATE_CONFLICT", screen_field_key=spec["screen_field_key"]))
        observations.append(field)
    project_boxes(observations, meta)
    for field in observations:
        if field["original_bbox"] is None:
            field["reasons"].append("source_box_unavailable")
    candidate = dict(profile_id=definition["profile_id"], page_identity=definition["page_identity"],
                     publication_state="development_only", raw_field_definition_sha256=canonical_hash(definition),
                     fields=observations, issues=issues,
                     coverage=dict(status="partial", declared=len(observations),
                                   known=sum(field["reading"] == "known" for field in observations)),
                     ocr_evidence=dict(coordinate_space="rectified_pixels", screen_size=size, lines=lines))
    return dict(fields=None, heater_columns=0, warnings=["EST_WHITE_DEVELOPMENT_ONLY"],
                detail=dict(page_observations=candidate))
