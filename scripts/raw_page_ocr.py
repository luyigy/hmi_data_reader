"""OCR numeric cells missed or clipped by full-screen text detection."""

import re
from importlib.metadata import version

from raw_page import _inside, load_raw_definition


def engine_identity(engine):
    gpu = getattr(getattr(engine, "text_recognizer", None), "use_gpu", None)
    return {"library": "paddleocr", "version": version("paddleocr"),
            "device": "unknown" if gpu is None else "gpu" if gpu else "cpu",
            "class": type(engine).__name__}


def recover_raw_cells(engine, image, meta, lines):
    result = list(lines)
    height, width = image.shape[:2]
    for spec in load_raw_definition()["fields"]:
        if spec["value_type"] != "number":
            continue
        existing = [line for line in result if _inside(line, spec["region"], [width, height])]
        if existing and spec["screen_field_key"] != "status.middle_displacement":
            continue
        x1, y1, x2, y2 = spec["region"]
        left, top, right, bottom = int(x1 * width), int(y1 * height), int(x2 * width), int(y2 * height)
        crop = image[top:bottom, left:right]
        output = engine.ocr(crop, cls=False)
        recovered = []
        for points, (text, confidence) in (output[0] or []):
            if not re.fullmatch(r"\s*[+-]?\d+(?:\.\d+)?\s*(?:mm|s)?\s*", text):
                continue
            xs, ys = zip(*points)
            recovered.append({"text": text, "conf": float(confidence),
                              "bbox": {"x_min": left + min(xs), "y_min": top + min(ys),
                                       "x_max": left + max(xs), "y_max": top + max(ys)},
                              "evidence_method": "cell_ocr"})
        if len(recovered) == 1:
            result = [line for line in result if line not in existing] + recovered
    return result
