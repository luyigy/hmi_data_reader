"""Physical observations for the BOLE B&R three-stage metering screen."""

import json
import re
from pathlib import Path
from statistics import median

from raw_page import _line_box
from extract_families.coordinates import project_boxes


PROFILE = "b_and_r.metering.three_stage"
DEFINITION = Path(__file__).resolve().parents[2] / "contracts/raw-pages/b-and-r-metering-1.0.0.json"
NUMBER = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*(mm/s|rpm|bar|mm|%|sec|s)?\s*$", re.I)


def extract_metering(lines, template, meta):
    definition = json.loads(DEFINITION.read_text())
    size = meta.get("screen_size")
    if not size or template.get("profile_id") != PROFILE:
        return dict(fields=None, heater_columns=0, warnings=["METERING_IDENTITY_INVALID"], detail={})
    cells = []
    for index, line in enumerate(lines):
        box = _line_box(line)
        cells.append(dict(line=line, index=index, text=re.sub(r"\s+", "", line["text"]),
                          confidence=float(line.get("conf", line.get("confidence", 0))),
                          x=(box[0] + box[2]) / (2 * size[0]), y=(box[1] + box[3]) / (2 * size[1]),
                          height=(box[3] - box[1]) / size[1], match=NUMBER.fullmatch(line["text"])))

    def labels(text):
        return [cell for cell in cells if cell["text"] == text]

    anchors = [labels(text) for text in ("前抽", "后抽", "模式", "计时器")]
    if any(len(group) != 1 for group in anchors):
        return dict(fields=None, heater_columns=0, warnings=["METERING_LAYOUT_UNVERIFIED"], detail={})
    before, after, mode, timer = [group[0] for group in anchors]
    if not before["x"] < after["x"] or not before["y"] < mode["y"] < timer["y"]:
        return dict(fields=None, heater_columns=0, warnings=["METERING_LAYOUT_CONFLICT"], detail={})
    numeric = [cell for cell in cells if cell["match"]]
    table = [cell for cell in numeric if before["y"] + before["height"] < cell["y"] < mode["y"] - mode["height"]]
    groups = []
    for cell in sorted(table, key=lambda item: item["y"]):
        group = next((row for row in groups if abs(median(c["y"] for c in row) - cell["y"])
                      < median(c["height"] for c in row) * .9), None)
        if group is None:
            groups.append([cell])
        else:
            group.append(cell)
    if len(groups) != 4:
        return dict(fields=None, heater_columns=0, warnings=["METERING_ROWS_INCOMPLETE"], detail={})
    stage_heads = sorted([cell for cell in cells if cell["text"] in ("1", "2", "3")
                          and cell["x"] < before["x"] and abs(cell["y"] - before["y"]) < .03],
                         key=lambda cell: cell["x"])
    observed_ids = [int(cell["text"]) for cell in stage_heads]
    if len(observed_ids) != len(set(observed_ids)):
        return dict(fields=None, heater_columns=0, warnings=["STAGE_IDENTITY_CONFLICT"], detail={})
    stage_order = observed_ids if set(observed_ids) == {1, 2, 3} else [1, 2, 3]
    assignments, row_units, row_labels = {}, {}, {}
    issues = list(definition["issues"])
    if len(stage_heads) != 3:
        issues.append(dict(code="STAGE_HEADERS_PARTIAL", reason="Physical slots use the verified definition; unread headings remain unverified"))
    for row_name, group in zip(("speed", "pressure", "back_pressure", "end_position"), groups):
        row_y = median(cell["y"] for cell in group)
        row_label = [cell for cell in cells if cell["x"] < min(c["x"] for c in group)
                     and abs(cell["y"] - row_y) < .02 and not cell["match"]]
        unit_cells = [cell for cell in cells if cell["text"].lower() in ("%", "bar", "mm")
                      and abs(cell["y"] - row_y) < .02]
        left = sorted([cell for cell in group if cell["x"] < before["x"] - .08], key=lambda cell: cell["x"])
        right = sorted([cell for cell in group if cell["x"] >= before["x"] - .08], key=lambda cell: cell["x"])
        for position, stage in enumerate(stage_order):
            key = f"storage.{row_name}.stage-{stage}"
            assignments[key] = [left[position]] if len(left) == 3 else []
            if len(left) != 3:
                issues.append(dict(code="STORAGE_ROW_CARDINALITY_CONFLICT", screen_field_key=key))
            row_units[key] = unit_cells[0] if len({cell["text"].lower() for cell in unit_cells}) == 1 else None
            row_labels[key] = row_label[0] if len(row_label) == 1 else None
        if row_name != "back_pressure":
            key_name = "distance" if row_name == "end_position" else row_name
            for position, segment in enumerate(("before_storage", "after_storage")):
                key = f"decompression.{segment}.{key_name}"
                assignments[key] = [right[position]] if len(right) == 2 else []
                row_units[key] = unit_cells[-1] if unit_cells else None
                row_labels[key] = row_label[0] if len(row_label) == 1 else None
    fields = []
    for spec in definition["fields"]:
        key = spec["screen_field_key"]
        source_label = row_labels.get(key)
        options = assignments.get(key)
        unit_cell = row_units.get(key)
        if options is None:
            label_options = labels(spec["label"])
            if spec["section"] == "header":
                label_options = [cell for cell in label_options if cell["y"] < before["y"] - .08]
            elif spec["section"] == "actual":
                label_options = [cell for cell in label_options if cell["y"] < before["y"]]
            source_label = label_options[0] if len(label_options) == 1 else None
            options = []
            if source_label:
                lx, ly = source_label["x"], source_label["y"]
                if spec["section"] in ("header", "actual"):
                    options = [cell for cell in numeric if 0 < cell["y"] - ly < .065
                               and abs(cell["x"] - lx) < .08]
                elif spec["section"] == "control":
                    options = [cell for cell in cells if cell["x"] > lx + .08
                               and abs(cell["y"] - ly) < .02 and cell["text"] in ("顺序动作", "同时动作", "关", "开")]
                else:
                    nearby = sorted([cell for cell in numeric if cell["x"] > lx + .04
                                     and abs(cell["y"] - ly) < .02], key=lambda cell: cell["x"])
                    offset = 1 if spec["role"] == "actual" else 0
                    options = nearby[offset:offset + 1]
        source = options[0] if len(options) == 1 else None
        confidence = source["confidence"] if source else None
        unit = source["match"][2] if source and source["match"] else None
        if source and unit is None:
            if unit_cell is None:
                nearby_units = [cell for cell in cells if source["x"] < cell["x"] < source["x"] + .15
                                and abs(cell["y"] - source["y"]) < .02
                                and cell["text"].lower() in ("mm/s", "rpm", "bar", "mm", "%", "sec", "s")]
                unit_cell = nearby_units[0] if len(nearby_units) == 1 else None
            unit = unit_cell["line"]["text"] if unit_cell else None
        reading = ("conflict" if len(options) > 1 else "missing" if source is None else
                   "uncertain" if confidence < .9 or source_label is None else "known")
        normalized_unit = unit.lower() if unit else None
        if normalized_unit == "sec":
            normalized_unit = "s"
        if unit is not None and normalized_unit != spec["unit"]:
            reading = "conflict"
        if spec.get("stage") and len(stage_heads) != 3 and reading == "known":
            reading = "uncertain"
        field = {name: spec[name] for name in ("screen_field_key", "section", "role", "stage", "segment_id", "order", "time_kind") if name in spec}
        if spec.get("stage"):
            field["order"] = stage_order.index(spec["stage"]) + 1
        field.update(source="image_recognition", original_label=source_label["line"]["text"] if source_label else None,
                     original_value=(float(source["match"][1]) if source["match"] else source["line"]["text"]) if source else None,
                     original_unit=unit, effective_unit=unit or spec["unit"], state="unknown", reading=reading,
                     text=source["line"]["text"] if source else None, confidence=confidence,
                     bbox=_line_box(source["line"]) if source else None, original_bbox=None,
                     reasons=["enable_state_unverified"])
        if reading != "known":
            issues.append(dict(code="READING_" + reading.upper(), screen_field_key=key))
        fields.append(field)
    by_key = {field["screen_field_key"]: field for field in fields}
    for header, actual in (("header.injection_position", "metering.actual.position"),
                           ("header.screw_speed", "metering.actual.rotation")):
        pair = [by_key[header], by_key[actual]]
        if all(field["original_value"] is not None for field in pair) and pair[0]["original_value"] != pair[1]["original_value"]:
            for field in pair:
                field["reading"] = "conflict"
                field["reasons"].append("same_sensor_readings_disagree")
            issues.append(dict(code="ACTUAL_SENSOR_CONFLICT", screen_field_keys=[header, actual]))
    project_boxes(fields, meta)
    for field in fields:
        if field["original_bbox"] is None:
            field["reasons"].append("source_box_unavailable")
    return dict(fields={}, heater_columns=0, warnings=["RAW_SCREEN_REVIEW_REQUIRED"], detail=dict(
        page_observations=dict(profile_id=PROFILE, fields=fields, issues=issues,
                               coverage=dict(status="partial", declared=len(fields), known=sum(f["reading"] == "known" for f in fields)))))
