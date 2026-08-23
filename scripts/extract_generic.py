"""Conservative template-free OCR evidence and extraction."""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path


CATALOG_PATH = Path(__file__).resolve().parents[1] / "contracts" / "field_catalog.json"
NUMBER_RE = re.compile(r"(?<![\d.])-?\d+(?:\.\d+)?")

# Explicit aliases and broad physical bounds are gates, not fuzzy semantic guesses.
FIELD_RULES = {
    "cooling_time_s": (["冷却时间", "coolingtime"], (0, 3600)),
    "holding_time_s": (["保压时间", "holdingtime"], (0, 3600)),
    "holding_pressure_bar": (["保压压力", "holdingpressure"], (0, 3000)),
    "switch_position_mm": (["v/p切换位置", "vp切换位置", "转保位置"], (-1000, 5000)),
    "switch_pressure_bar": (["v/p切换压力", "vp切换压力", "转保压力"], (0, 3000)),
    "switch_time_s": (["v/p切换时间", "vp切换时间", "转保时间"], (0, 3600)),
    "injection_velocity_mms": (["射胶速度", "注射速度", "射出速度"], (0, 2000)),
    "injection_pressure_limit_bar": (["射胶压力上限", "注射压力上限"], (0, 3000)),
    "mold_temperature_set_c": (["模温设定", "模具温度设定"], (-50, 500)),
    "mold_temperature_current_c": (["模温实际", "模温当前", "模具实际温度"], (-50, 500)),
}


def _norm(text: str) -> str:
    return re.sub(r"[\s:：=℃°（）()\[\]_-]+", "", text).lower()


@lru_cache(maxsize=1)
def _catalog_fields() -> dict[str, dict]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))["fields"]


def _tokens(lines: list[dict], screen_size: list[int]) -> list[dict]:
    width, height = screen_size
    if width <= 0 or height <= 0:
        return []
    result = []
    for index, line in enumerate(lines):
        box = line.get("bbox") or {}
        try:
            x0, x1 = float(box["x_min"]) / width, float(box["x_max"]) / width
            y0, y1 = float(box["y_min"]) / height, float(box["y_max"]) / height
            text = str(line["text"]).strip()
            conf = float(line.get("conf", 0))
        except (KeyError, TypeError, ValueError):
            continue
        if text:
            result.append({"id": f"t{index}", "text": text, "norm": _norm(text),
                           "conf": conf, "x0": x0, "x1": x1, "y0": y0, "y1": y1,
                           "x": (x0 + x1) / 2, "y": (y0 + y1) / 2})
    return result


def _number_entries(token: dict) -> list[tuple[float, float, str]]:
    matches = list(NUMBER_RE.finditer(token["text"]))
    span = max(len(token["text"]), 1)
    return [
        (float(match.group()), token["x0"] +
         (match.start() + len(match.group()) / 2) / span * (token["x1"] - token["x0"]),
         token["id"])
        for match in matches
    ]


def _evidence_rows(tokens: list[dict]) -> list[dict]:
    rows: list[list[dict]] = []
    for token in sorted(tokens, key=lambda item: (item["y"], item["x"])):
        tolerance = max(token["y1"] - token["y0"], 0.012)
        if rows and abs(token["y"] - sum(t["y"] for t in rows[-1]) / len(rows[-1])) <= tolerance:
            rows[-1].append(token)
        else:
            rows.append([token])
    result = []
    for row in rows:
        ordered = sorted(row, key=lambda item: item["x"])
        result.append({
            "label_token_ids": [t["id"] for t in ordered if _is_label_token(t)],
            "value_token_ids": [t["id"] for t in ordered if _number_entries(t)],
            "text": " ".join(t["text"] for t in ordered),
            "order": "screen_left_to_right",
        })
    return result


def _is_label_token(token: dict) -> bool:
    return (_row_kind(token["text"]) is not None
            or any(_norm(alias) in token["norm"]
                   for aliases, _ in FIELD_RULES.values() for alias in aliases)
            or any(word in token["norm"] for word in
                   ("温度", "温区", "料筒", "喷嘴", "加热", "temperature")))


def _field_allowed(field: str, page_type: str, value_type: str) -> bool:
    meta = _catalog_fields().get(field) or {}
    return page_type in (meta.get("source_pages") or []) and meta.get("value_type") == value_type


def _near_values(label: dict, tokens: list[dict]) -> list[dict]:
    candidates = []
    label_h = max(label["y1"] - label["y0"], 0.01)
    for token in tokens:
        if token is label or len(_number_entries(token)) != 1:
            continue
        token_h = max(token["y1"] - token["y0"], 0.01)
        same_row = (label["x1"] - 0.01 <= token["x0"] <= label["x1"] + 0.30
                    and abs(token["y"] - label["y"]) <= max(label_h, token_h))
        below = (token["y0"] >= label["y1"] - 0.005
                 and token["y0"] - label["y1"] <= 3 * label_h
                 and abs(token["x"] - label["x"]) <= max(
                     label["x1"] - label["x0"], token["x1"] - token["x0"]))
        if same_row or below:
            candidates.append(token)
    return candidates


def _spatial_kv(tokens: list[dict], page_type: str) -> tuple[dict, list[dict], list[dict]]:
    fields, mappings, unresolved = {}, [], []
    for field, (aliases, limits) in FIELD_RULES.items():
        labels = [t for t in tokens if any(_norm(alias) in t["norm"] for alias in aliases)]
        if not labels:
            continue
        label_ids = [t["id"] for t in labels]
        if not _field_allowed(field, page_type, "float"):
            unresolved.append({"field": field, "reason": "PAGE_OR_TYPE_MISMATCH",
                               "label_token_ids": label_ids, "value_token_ids": []})
            continue
        if len(labels) != 1:
            unresolved.append({"field": field, "reason": "LABEL_NOT_UNIQUE",
                               "label_token_ids": label_ids, "value_token_ids": []})
            continue
        label = labels[0]
        inline = _number_entries(label)
        candidates = [label] if len(inline) == 1 else _near_values(label, tokens)
        if len(candidates) != 1:
            unresolved.append({"field": field, "reason": "VALUE_ADJACENCY_AMBIGUOUS",
                               "label_token_ids": label_ids,
                               "value_token_ids": [t["id"] for t in candidates]})
            continue
        source = candidates[0]
        entries = _number_entries(source)
        if len(entries) != 1 or not limits[0] <= entries[0][0] <= limits[1]:
            unresolved.append({"field": field, "reason": "VALUE_INVALID",
                               "label_token_ids": label_ids,
                               "value_token_ids": [source["id"]]})
            continue
        fields[field] = entries[0][0]
        mappings.append({"field": field, "label_token_ids": label_ids,
                         "value_token_ids": [source["id"]]})
    return fields, mappings, unresolved


def _row_kind(text: str) -> str | None:
    normalized = _norm(text)
    if ("设定" in normalized or "设置" in normalized or normalized in ("set", "sv")
            or re.match(r"^(?:set|sv)-?\d", normalized)):
        return "set"
    if (any(word in normalized for word in ("实际", "当前", "现在"))
            or normalized in ("actual", "pv") or re.match(r"^(?:actual|pv)-?\d", normalized)):
        return "current"
    return None


def _dynamic_grid(tokens: list[dict], page_type: str) -> tuple[dict, list[dict], list[dict]]:
    fields, mappings, unresolved = {}, [], []
    context = [t for t in tokens if any(word in t["norm"] for word in
               ("温度", "温区", "料筒", "喷嘴", "加热", "temperature"))]
    labels = {kind: [t for t in tokens if _row_kind(t["text"]) == kind]
              for kind in ("set", "current")}
    relevant = bool(context) or any(labels.values())
    if not relevant:
        return fields, mappings, unresolved
    if page_type != "temperature" or len(context) != 1 or any(len(labels[kind]) != 1 for kind in labels):
        unresolved.append({"field": "barrel_temperature_rows",
                           "reason": "GRID_SEMANTICS_AMBIGUOUS",
                           "label_token_ids": [t["id"] for t in context + labels["set"] + labels["current"]],
                           "value_token_ids": []})
        return fields, mappings, unresolved

    rows = {}
    for kind, row_labels in labels.items():
        label = row_labels[0]
        row_h = max(label["y1"] - label["y0"], 0.012)
        row_tokens = [t for t in tokens if t is label or
                      (t["x1"] >= label["x1"] - 0.01
                       and abs(t["y"] - label["y"]) <= max(
                           row_h, t["y1"] - t["y0"]))]
        entries = sorted((entry for token in row_tokens for entry in _number_entries(token)),
                         key=lambda entry: entry[1])
        rows[kind] = (label, entries)

    set_entries, current_entries = rows["set"][1], rows["current"][1]
    aligned = (len(set_entries) >= 2 and len(set_entries) == len(current_entries)
               and all(abs(a[1] - b[1]) <= 0.035
                       for a, b in zip(set_entries, current_entries)))
    valid = aligned and all(-50 <= value <= 500
                            for value, _, _ in set_entries + current_entries)
    if not valid:
        unresolved.append({"field": "barrel_temperature_rows",
                           "reason": "GRID_COLUMNS_UNALIGNED_OR_VALUE_INVALID",
                           "label_token_ids": [rows[kind][0]["id"] for kind in ("set", "current")],
                           "value_token_ids": list(dict.fromkeys(
                               entry[2] for entries in (set_entries, current_entries) for entry in entries))})
        return fields, mappings, unresolved

    for kind, field in (("set", "barrel_temperature_set_c"),
                        ("current", "barrel_temperature_current_c")):
        if not _field_allowed(field, page_type, "list[float]"):
            continue
        label, entries = rows[kind]
        fields[field] = [value for value, _, _ in entries]
        mappings.append({"field": field, "label_token_ids": [context[0]["id"], label["id"]],
                         "value_token_ids": list(dict.fromkeys(entry[2] for entry in entries)),
                         "order": "screen_left_to_right"})
    return fields, mappings, unresolved


def extract_generic(ocr_data: dict, screen_size: list[int], page_type: str) -> dict:
    """Build auditable OCR evidence and map only deterministic catalog fields."""
    tokens = _tokens(ocr_data.get("lines", []), screen_size)
    scalar, scalar_mappings, unresolved = _spatial_kv(tokens, page_type)
    grid, grid_mappings, grid_unresolved = _dynamic_grid(tokens, page_type)
    fields = {**grid, **scalar}
    evidence_tokens = {t["id"]: {"text": t["text"], "conf": t["conf"],
                                  "bbox": [t["x0"], t["y0"], t["x1"], t["y1"]]}
                       for t in tokens}
    unresolved += grid_unresolved
    return {
        "fields": fields or None,
        "warnings": ([f"GENERIC_UNRESOLVED({item['field']},{item['reason']})"
                      for item in unresolved] + ([] if fields else ["NO_GENERIC_FIELDS"])),
        "detail": {
            "engine": "spatial-kv+dynamic-grid",
            "evidence": {"page_type": page_type, "tokens": evidence_tokens,
                         "rows": _evidence_rows(tokens)},
            "mappings": grid_mappings + scalar_mappings,
            "unresolved": unresolved,
        },
    }
