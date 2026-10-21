"""YIZUMI F2 injection/holding table: observed cells only, with uncertain stage state."""
import re

from extract_families.coordinates import project_boxes

NUMBER = re.compile(r"([+-]?\d+(?:\.\d+)?)\s*(mm|bar|%|s)?", re.I)
STAGE = {"一段": 1, "二段": 2, "三段": 3, "四段": 4, "五段": 5, "六段": 6}
ROWS = {"位置": ("position", "mm"), "压力": ("pressure", "bar"),
        "速度": ("speed", "%"), "时间": ("time", "s")}


def extract(lines, template, meta, image_path=None):
    """Associate one OCR number with one printed stage and row; ambiguous cells stay unknown."""
    if not meta.get("screen_size"):
        return dict(fields=None, heater_columns=0, warnings=["SCREEN_SIZE_MISSING"], detail={})
    width, height = meta["screen_size"]
    cells = []
    for index, line in enumerate(lines):
        box = line.get("bbox") or {}
        if not all(key in box for key in ("x_min", "y_min", "x_max", "y_max")):
            continue
        cells.append(dict(text=line["text"].strip(), confidence=float(line["conf"]),
                          bbox=[box[key] for key in ("x_min", "y_min", "x_max", "y_max")],
                          index=index))

    def center(cell):
        x1, y1, x2, y2 = cell["bbox"]
        return (x1 + x2) / 2, (y1 + y2) / 2

    def section_label(text, minimum_y=0):
        found = [cell for cell in cells if cell["text"] == text and
                 width * .24 < center(cell)[0] < width * .55 and center(cell)[1] > minimum_y]
        return found[0] if len(found) == 1 else None

    injection = section_label("射胶")
    switch = section_label("切保压", center(injection)[1] if injection else 0)
    holding = section_label("保压", center(switch)[1] if switch else 0)
    if not all((injection, switch, holding)):
        return dict(fields=None, heater_columns=0, warnings=["YIZUMI_SECTION_MARKERS_MISSING"], detail={})

    observations = []
    counts = {}
    issues = []
    for section, marker, stop in (("injection", injection, switch),
                                  ("holding", holding, None)):
        top = center(marker)[1]
        bottom = center(stop)[1] if stop else min(height * .95, top + height * .2)
        headings = [(STAGE[cell["text"]], cell) for cell in cells if cell["text"] in STAGE
                    and center(cell)[0] > width * .55
                    and top - height * .025 <= center(cell)[1] < top + height * .045]
        for cell in cells:
            names = re.findall(r"[一二三四五六]段", cell["text"])
            if (len(names) < 2 or "".join(names) != cell["text"]
                    or center(cell)[0] <= width * .55
                    or not top - height * .025 <= center(cell)[1] < top + height * .045):
                continue
            x1, y1, x2, y2 = cell["bbox"]
            for offset, name in enumerate(names):
                part = {**cell, "bbox": [x1 + (x2 - x1) * offset / len(names), y1,
                                          x1 + (x2 - x1) * (offset + 1) / len(names), y2]}
                headings.append((STAGE[name], part))
        stage_ids = [stage for stage, _ in headings]
        duplicates = sorted({stage for stage in stage_ids if stage_ids.count(stage) > 1})
        if duplicates:
            issues.append(dict(code="YIZUMI_STAGE_IDENTITY_CONFLICT", section=section,
                               stage_ids=duplicates, line_indexes=sorted({cell["index"]
                                   for stage, cell in headings if stage in duplicates})))
            continue
        if not headings:
            continue
        count_labels = [cell for cell in cells if re.fullmatch(r"段数\s*[1-6]?", cell["text"])
                        and center(cell)[0] > width * .55 and cell["confidence"] >= .8
                        and top - height * .09 <= center(cell)[1] <= top + height * .05]
        if len(count_labels) == 1:
            label = count_labels[0]
            match = re.search(r"([1-6])$", label["text"])
            options = [cell for cell in cells if re.fullmatch(r"[1-6]", cell["text"])
                       and cell["confidence"] >= .8
                       and 0 < center(cell)[0] - center(label)[0] < width * .12
                       and abs(center(cell)[1] - center(label)[1]) < height * .012]
            if match or len(options) == 1:
                counts[section] = dict(value=int(match.group(1)) if match else int(options[0]["text"]),
                                       line_indexes=[label["index"]] + ([] if match else [options[0]["index"]]))
        headings.sort(key=lambda pair: center(pair[1])[0])
        columns = [center(cell)[0] for _, cell in headings]
        spacing = min((b - a for a, b in zip(columns, columns[1:])), default=width * .085)
        row_labels = [cell for cell in cells if cell["text"] in ROWS
                      and center(marker)[0] - width * .035 <= center(cell)[0] < width * .5
                      and top < center(cell)[1] < bottom]
        row_labels.sort(key=lambda cell: center(cell)[1])
        expected_rows = ["位置", "压力", "速度", "时间"] if section == "injection" else ["压力", "速度", "时间"]
        row_tail = height * (.025 if section == "injection" else .05)
        # The photographed screen is skewed: a row's label and numeric cells may differ
        # by 20-40 px. Pair the ordered numeric row bands with printed row order instead.
        data = [cell for cell in cells if re.match(r"^[+\-\d.]", cell["text"])
                and any(char.isdigit() for char in cell["text"])
                and min(columns) - spacing * .48 < center(cell)[0] < max(columns) + spacing * .48
                and top < center(cell)[1] < min(bottom, center(row_labels[-1])[1] + row_tail)
                and cell["text"] not in STAGE]
        data.sort(key=lambda cell: center(cell)[1])
        bands = []
        for cell in data:
            if not bands or center(cell)[1] - center(bands[-1][-1])[1] > height * .012:
                bands.append([])
            bands[-1].append(cell)
        if [cell["text"] for cell in row_labels] != expected_rows or len(bands) != len(expected_rows):
            continue
        for label, band in zip(row_labels, bands):
            kind, declared_unit = ROWS[label["text"]]
            row_y = sum(center(cell)[1] for cell in band) / len(band)
            for stage, heading in headings:
                column_x = center(heading)[0]
                found = [(cell, NUMBER.fullmatch(cell["text"])) for cell in band
                         if abs(center(cell)[1] - row_y) <= height * .012
                         and abs(center(cell)[0] - column_x) < spacing * .46
                         and cell["bbox"][2] - cell["bbox"][0] < spacing * .9]
                found = [(cell, match) for cell, match in found if match]
                chosen = found[0] if len(found) == 1 and found[0][0]["confidence"] >= .8 else None
                value = float(chosen[1].group(1)) if chosen else None
                observed_unit = chosen[1].group(2) if chosen else None
                # Printed row units are page evidence; OCR-free units remain unresolved.
                unit_cells = [cell for cell in cells if cell["text"].casefold() == declared_unit.casefold()
                              and center(cell)[0] > max(columns) + spacing * .25
                              and abs(center(cell)[1] - row_y) <= height * .012]
                unit = observed_unit or (declared_unit if len(unit_cells) == 1 else None)
                reasons = ["stage_state_unverified"]
                if not chosen:
                    reasons.append("value_missing_or_ambiguous")
                if not unit:
                    reasons.append("unit_unobserved")
                role = "unknown" if kind in ("position", "pressure") or (
                    section == "injection" and kind == "time") else "setting"
                if role == "unknown":
                    reasons.append("physical_semantics_unconfirmed")
                observations.append(dict(label=f"{'射胶' if section == 'injection' else '保压'}{label['text']}{stage}",
                    value=value, unit=unit, role=role, section=section, stage=stage,
                    state="unknown", state_basis=None, text=chosen[0]["text"] if chosen else None,
                    confidence=min(label["confidence"], chosen[0]["confidence"]) if chosen else 0,
                    bbox=chosen[0]["bbox"] if chosen else None, original_bbox=None,
                    line_indexes=[label["index"], heading["index"]] + ([chosen[0]["index"]] if chosen else []),
                    reasons=reasons))
    project_boxes(observations, meta)
    detail = dict(page_variant=template["layout_variant"], page_observations=dict(
        version="1.0", profile_id=template["profile_id"], coordinate_space="original_percent",
        fields=observations, stage_counts=counts, visual_stage_counts={}))
    if issues:
        detail["page_observations"]["issues"] = issues
    return dict(fields={}, heater_columns=0,
                warnings=["YIZUMI_REVIEW_REQUIRED"] + sorted({issue["code"] for issue in issues}), detail=detail)
