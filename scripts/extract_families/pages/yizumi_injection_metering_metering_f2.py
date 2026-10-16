"""YIZUMI 31 F2 metering screen: keep photographed settings as reviewable facts."""
import re

from extract_families.tact5_process import project_boxes


NUMBER = re.compile(r"([+-]?\d+(?:\.\d+)?)\s*(mm|bar|%|s)?", re.I)
ROWS = {"位置": "mm", "压力": "bar", "速度": "%", "背压": "bar"}


def extract(lines, template, meta, image_path=None):
    if not meta.get("screen_size"):
        return dict(fields=None, heater_columns=0, warnings=["SCREEN_SIZE_MISSING"], detail={})
    width, height = meta["screen_size"]
    cells = []
    for index, line in enumerate(lines):
        box = line.get("bbox") or {}
        if all(key in box for key in ("x_min", "y_min", "x_max", "y_max")):
            cells.append(dict(text=line["text"].strip(), confidence=float(line["conf"]),
                              bbox=[box[key] for key in ("x_min", "y_min", "x_max", "y_max")],
                              index=index))

    def xy(cell):
        x1, y1, x2, y2 = cell["bbox"]
        return (x1 + x2) / 2, (y1 + y2) / 2

    headings = [(stage, cell) for cell in cells for stage in (1, 2)
                if cell["text"] == f"熔胶{stage}" and width * .55 < xy(cell)[0] < width * .8
                and height * .34 < xy(cell)[1] < height * .42]
    row_labels = {cell["text"]: cell for cell in cells if cell["text"] in ROWS
                  and width * .33 < xy(cell)[0] < width * .43
                  and height * .40 < xy(cell)[1] < height * .58}
    if len(headings) != 2 or {stage for stage, _ in headings} != {1, 2} or set(row_labels) != set(ROWS):
        return dict(fields=None, heater_columns=0,
                    warnings=["YIZUMI_METERING_GRID_MISSING"], detail={})
    columns = {stage: xy(cell)[0] for stage, cell in headings}
    spacing = abs(columns[2] - columns[1])
    counts = {}
    count_labels = [cell for cell in cells if cell['text'] == '段数' and cell['confidence'] >= .8
                    and width * .55 < xy(cell)[0] < width * .85
                    and height * .33 < xy(cell)[1] < height * .43]
    if len(count_labels) == 1:
        label = count_labels[0]
        numbers = [cell for cell in cells if re.fullmatch(r'[1-2]', cell['text'])
                   and cell['confidence'] >= .8
                   and 0 < xy(cell)[0] - xy(label)[0] < width * .12
                   and abs(xy(cell)[1] - xy(label)[1]) < height * .012]
        if len(numbers) == 1:
            counts['plasticizing'] = dict(value=int(numbers[0]['text']),
                                          line_indexes=[label['index'], numbers[0]['index']])
    observations = []
    for label, declared_unit in ROWS.items():
        row = row_labels[label]
        row_y = xy(row)[1]
        unit_cells = [cell for cell in cells if cell["text"].casefold() == declared_unit.casefold()
                      and width * .78 < xy(cell)[0] < width * .98
                      and abs(xy(cell)[1] - row_y) < height * .024]
        for stage, heading in headings:
            options = [(cell, NUMBER.fullmatch(cell["text"])) for cell in cells
                       if abs(xy(cell)[0] - columns[stage]) < spacing * .48
                       and abs(xy(cell)[1] - row_y) < height * .024
                       and cell["index"] != row["index"]]
            options = [(cell, match) for cell, match in options if match]
            chosen = options[0] if len(options) == 1 and options[0][0]["confidence"] >= .8 else None
            value = float(chosen[1].group(1)) if chosen else None
            unit = (chosen[1].group(2) if chosen else None) or (declared_unit if unit_cells else None)
            reasons = ["stage_state_unverified", "physical_semantics_unconfirmed"]
            if chosen is None:
                reasons.append("value_missing_or_ambiguous")
            if unit is None:
                reasons.append("unit_unobserved")
            observations.append(dict(label=f"熔胶{label}{stage}", value=value, unit=unit,
                role="unknown", section="plasticizing", stage=stage, state="unknown",
                state_basis=None, text=chosen[0]["text"] if chosen else None,
                confidence=min(row["confidence"], chosen[0]["confidence"]) if chosen else 0,
                bbox=chosen[0]["bbox"] if chosen else None, original_bbox=None,
                line_indexes=[row["index"], heading["index"]] + ([chosen[0]["index"]] if chosen else []),
                reasons=reasons))
    project_boxes(observations, meta)
    detail = dict(page_variant=template["layout_variant"], page_observations=dict(
        version="1.0", profile_id=template["profile_id"], coordinate_space="original_percent",
        fields=observations, stage_counts=counts, visual_stage_counts={}))
    return dict(fields={}, heater_columns=0, warnings=["YIZUMI_REVIEW_REQUIRED"], detail=detail)
