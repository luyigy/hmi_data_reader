"""Fixed decimal display checks and genuine cell OCR for SELOGICA 1.0.1."""

import json
import re
from pathlib import Path

from extract_families.arburg_metering import extract_selogica, NUMBER
from raw_page import _line_box

DEFINITION = Path(__file__).resolve().parents[2] / "contracts/raw-pages/arburg-selogica-metering-1.0.1.json"


def decimal_format(text, places):
    match = NUMBER.fullmatch(text or "")
    return bool(match and re.fullmatch(r"[+-]?\d+\.\d{" + str(places) + r"}", match[1]))


def extract_decimal_selogica(lines, template, meta):
    result = extract_selogica(lines, template, meta)
    if not result["detail"]:
        return result
    specs = {f["screen_field_key"]: f for f in json.loads(DEFINITION.read_text())["fields"]}
    observation = result["detail"]["page_observations"]
    for field in observation["fields"]:
        places = specs[field["screen_field_key"]].get("decimal_places")
        if (places is not None and field["original_value"] is not None
                and field["reading"] in ("known", "uncertain") and not decimal_format(field["text"], places)):
            field["reading"] = "uncertain"
            field["reasons"].append("display_decimal_format_unverified")
            observation["issues"].append(dict(code="READING_UNCERTAIN", screen_field_key=field["screen_field_key"]))
        evidence = [line for line in lines if field["bbox"] is not None and _line_box(line) == field["bbox"]]
        if len(evidence) == 1 and evidence[0].get("evidence_method") == "decimal_cell_ocr":
            field["evidence_method"] = "decimal_cell_ocr"
            previous = evidence[0]["supersedes_ocr"]
            field["supersedes_ocr"] = dict(text=previous["text"],
                                           confidence=previous.get("conf", previous.get("confidence")),
                                           bbox=_line_box(previous))
    observation["coverage"]["known"] = sum(f["reading"] == "known" for f in observation["fields"])
    return result


def recover_decimal_cells(engine, image, meta, lines):
    import cv2
    if image is None:
        return lines
    specs = {f["screen_field_key"]: f for f in json.loads(DEFINITION.read_text())["fields"]}
    from extract_families.arburg_metering import PROFILE
    trial = extract_decimal_selogica(lines, {"profile_id": PROFILE}, meta)
    if not trial["detail"]:
        return lines
    result = list(lines)
    height, width = image.shape[:2]
    for field in trial["detail"]["page_observations"]["fields"]:
        if "display_decimal_format_unverified" not in field["reasons"]:
            continue
        source = [line for line in result if _line_box(line) == field["bbox"] and line["text"] == field["text"]]
        if len(source) != 1:
            continue
        x1, y1, x2, y2 = field["bbox"]
        left, top, right, bottom = max(0, int(x1) - 8), max(0, int(y1) - 8), min(width, int(x2) + 8), min(height, int(y2) + 8)
        crop = cv2.resize(image[top:bottom, left:right], None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
        crop = cv2.copyMakeBorder(crop, 30, 30, 30, 30, cv2.BORDER_CONSTANT, value=255)
        raw = engine.ocr(crop, cls=False)
        spec = specs[field["screen_field_key"]]
        candidates = []
        for points, (text, confidence) in raw[0] or []:
            if not decimal_format(text, spec["decimal_places"]) or confidence < .9:
                continue
            unit = NUMBER.fullmatch(text)[2]
            if unit is not None and unit != spec["unit"]:
                continue
            xs, ys = zip(*points)
            box = dict(x_min=left + (min(xs) - 30) / 4, y_min=top + (min(ys) - 30) / 4,
                       x_max=left + (max(xs) - 30) / 4, y_max=top + (max(ys) - 30) / 4)
            if not (left <= box["x_min"] < box["x_max"] <= right and top <= box["y_min"] < box["y_max"] <= bottom):
                continue
            candidates.append(dict(text=text, conf=float(confidence), bbox=box,
                                   evidence_method="decimal_cell_ocr", scale=4, padding=[30, 30],
                                   supersedes_ocr=source[0]))
        if len(candidates) == 1:
            result = [line for line in result if line is not source[0]] + candidates
    return result
