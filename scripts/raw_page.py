"""Shared OCR box and content-hash primitives. No page-specific interpretation."""
import hashlib
import json

def content_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()

def _line_box(line):
    box = line["bbox"]
    return [box[k] for k in ("x_min", "y_min", "x_max", "y_max")] if isinstance(box, dict) else box

def _inside(line, region, size):
    x1, y1, x2, y2 = _line_box(line)
    x, y = (x1 + x2) / (2 * size[0]), (y1 + y2) / (2 * size[1])
    return region[0] <= x <= region[2] and region[1] <= y <= region[3]
