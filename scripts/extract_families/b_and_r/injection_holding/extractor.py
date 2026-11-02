"""Extract fields for the supported B&R injection/holding profile."""

# 字段提取层：布局确定格子归属后，这里读取数值、核对范围/置信度，并保留待核对原因。
# v1 入口 extract_injection_b_and_r；v2 兼容入口 observe_bole_injection。
# 两种入口的布局均从 layout.py 获取；v2 仍保留旧定义的定位规则，未伪装成统一算法。
# 这里不管理版本包发布，也不决定 mold 标准参数的业务去向。

import re
from pathlib import Path

import cv2

from .layout import infer_active_stages, physical_rows, stage_identity, _section_y, _value_rows, VALUE_TEXT as NUM
from .layout import build_holding_layout, layout_evidence, build_raw_layout, _visual_active_count
from .page_identity import section_headers
from extract_families.visual_cells import bordered_cells
from extract_families.common import _anchor_match  # noqa: F401
from .page_result import b_and_r_page_observations, build_raw_observations
from .package import ROOT, PROFILE, VERSION, bole_injection_package
from raw_page import _line_box



def _first_num(text: str) -> float | None:
    m = NUM.fullmatch(text.strip())
    return float(m.group()) if m else None






def _row_values(cluster, rng, parse):
    lo, hi = rng
    out = []
    for t in cluster:
        v = parse(t["text"]) if t else None
        out.append(v if v is not None and lo <= v <= hi else None)
    return out


def _holding_field_readings(layout, ranges):
    """Keep value validation separate from layout identity and OCR confidence."""
    result = []
    for cell in layout.cells:
        unit_key = {'velocity': 'pct', 'pressure': 'bar', 'time': 's'}[cell.row_key]
        lo, hi = ranges[unit_key]
        value = _first_num(cell.raw_reading[0]) if len(cell.raw_reading) == 1 else None
        if value is not None and not lo <= value <= hi:
            value = None
        confidence = cell.ocr_confidences[0] if len(cell.ocr_confidences) == 1 else None
        reading = ('missing' if not cell.raw_reading else 'conflict' if len(cell.raw_reading) > 1
                   else 'known' if value is not None and confidence >= .8 else 'uncertain')
        result.append(dict(row_key=cell.row_key, stage_id=cell.stage_id,
                           raw_reading=cell.raw_reading, value=value, confidence=confidence,
                           mapping_status=cell.mapping_status, reading_status=reading,
                           stage_identity_verified=cell.stage_identity_verified,
                           automatic_eligible=(cell.mapping_status == 'verified' and reading == 'known'
                               and layout.active_stages is not None and cell.stage_id <= layout.active_stages)))
    return result


def extract_injection_b_and_r(toks: list[dict], template: dict, image_path: Path | None = None) -> dict:
    warnings: list[str] = []
    sc = template["sections"]
    vr = template["value_ranges"]
    gap = template["cluster_gap"]
    max_stages = template["max_stages"]
    detail: dict = {}
    gray = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE) if image_path is not None else None
    cells = bordered_cells(gray)
    row_cells = {}
    holding_layout = None

    # 区段头 y（保压切换唯一，反向链式锚定：保压=保压切换之上最近，射胶=保压之上最近）
    y_sw = _section_y(toks, sc["switch"]["header"])
    y_hold = _section_y(toks, sc["holding"]["header"], None)
    if y_sw is not None:
        hold_hits = [t for t in toks
                     if 0.35 < t["x"] < 0.65 and t["y"] < y_sw
                     and _anchor_match(sc["holding"]["header"], t["text"])]
        y_hold = max(hold_hits, key=lambda t: t["y"])["y"] if hold_hits else None
    y_inj = None
    if y_hold is not None:
        inj_hits = [t for t in toks
                    if 0.35 < t["x"] < 0.65 and t["y"] < y_hold
                    and _anchor_match(sc["injection"]["header"], t["text"])]
        y_inj = max(inj_hits, key=lambda t: t["y"])["y"] if inj_hits else None
    if template.get('profile_id') == 'b_and_r.injection_holding.multi_stage_position_time':
        headers = section_headers(toks)
        if headers is not None:
            y_inj, y_hold, y_sw = (headers[key]['y'] for key in ('injection', 'holding', 'switch'))
    if not (y_inj and y_hold and y_sw):
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"SECTION_NOT_FOUND({y_inj},{y_hold},{y_sw})"], "detail": {}}

    # 射胶表（区段：射胶头 ~ 保压头）
    inj_rows = _value_rows(toks, y_inj + 0.02, y_hold - 0.01, gap)
    if gray is not None:
        inj_rows, row_cells["injection"] = physical_rows(
            inj_rows, cells, (y_inj+.02)*gray.shape[0], (y_hold-.01)*gray.shape[0])
    inj: dict[str, list | None] = {"velocity": None, "pressure": None, "position": None}
    inj_tokens: dict[str, list] = {}
    if len(inj_rows) < (3 if gray is not None else len(sc["injection"]["rows"])):
        warnings.append(f"ROW_COUNT_LOW(injection,{len(inj_rows)})")
    for name, cl in zip(sc["injection"]["rows"], inj_rows):
        if name in sc["injection"]["skip_rows"]:
            continue
        rng = vr["pct"] if name == "velocity" else (vr["bar"] if name == "pressure" else vr["mm"])
        inj[name] = _row_values(cl, rng, _first_num)[:max_stages]
        inj_tokens[name] = cl[:max_stages]

    # 保压表（区段：保压头 ~ 保压切换头）
    hold_rows = _value_rows(toks, y_hold + 0.02, y_sw - 0.01, gap)
    detail['ocr_rows'] = {
        section: [[dict(value=_first_num(t['text']), confidence=t.get('conf', 0),
                        text=t['text'], bbox=t.get('bbox'), stage=None,
                        identity_verified=False) for t in row] for row in rows]
        for section, rows in (('injection', _value_rows(toks, y_inj+.02, y_hold-.01, gap)),
                              ('holding', hold_rows))}
    if gray is not None:
        reference = (row_cells['injection'][0][0]
                     if stage_identity(toks, row_cells['injection'], y_inj,
                                       (gray.shape[1], gray.shape[0])) else None)
        if template.get('profile_id') == 'b_and_r.injection_holding.multi_stage_position_time':
            holding_layout, hold_rows = build_holding_layout(
                toks, cells, y_hold*gray.shape[0], y_sw*gray.shape[0],
                (gray.shape[1], gray.shape[0]), gray, reference)
            detail['holding_layout'] = layout_evidence(holding_layout)
            detail['holding_fields'] = _holding_field_readings(holding_layout, vr)
            row_cells['holding'] = [
                [holding_layout.observed_borders[bid]
                 for cell in holding_layout.cells if cell.row_key == key
                 for bid in cell.observed_border_ids]
                for key in ('velocity', 'pressure', 'time')]
            for cell in holding_layout.cells:
                if cell.reasons:
                    warnings.append(f"LAYOUT_REVIEW(holding,{cell.row_key},{cell.stage_id},"
                                    f"{','.join(cell.reasons)})")
        else:
            hold_rows, row_cells['holding'] = physical_rows(
                hold_rows, cells, (y_hold+.02)*gray.shape[0], (y_sw-.01)*gray.shape[0])
    hold: dict[str, list | None] = {"velocity": None, "pressure": None, "time": None}
    hold_tokens: dict[str, list] = {}
    if len(hold_rows) < len(sc["holding"]["rows"]):
        warnings.append(f"ROW_COUNT_LOW(holding,{len(hold_rows)})")
    for name, cl in zip(sc["holding"]["rows"], hold_rows):
        rng = vr["pct"] if name == "velocity" else (vr["bar"] if name == "pressure" else vr["s"])
        hold[name] = _row_values(cl, rng, _first_num)[:max_stages]
        hold_tokens[name] = cl[:max_stages]

    detail["physical_rows"] = row_cells
    detail["raw_rows"] = {"injection": dict(inj), "holding": dict(hold)}
    identity = {}
    if gray is not None:
        identity["injection"] = stage_identity(toks, row_cells.get("injection"), y_inj,
                                                (gray.shape[1], gray.shape[0]))
        reference = row_cells["injection"][0][0] if identity["injection"] else None
        identity['holding'] = (holding_layout.stage_identity_verified if holding_layout is not None
                               else stage_identity(toks, row_cells.get('holding'), y_hold,
                                                   (gray.shape[1], gray.shape[0]), reference))
        if not identity["injection"] and identity["holding"]:
            identity["injection"] = stage_identity(
                toks, row_cells.get("injection"), y_inj, (gray.shape[1], gray.shape[0]),
                (holding_layout.cells[0].predicted_bbox if holding_layout is not None
                 else row_cells['holding'][0][0]))
        for section, values in (("injection", inj), ("holding", hold)):
            tokens_by_row = inj_tokens if section == 'injection' else hold_tokens
            detail.setdefault('cell_readings', {})[section] = {
                name: [dict(value=value,
                            confidence=(tokens_by_row[name][i].get('conf', 0)
                                        if tokens_by_row[name][i] else None),
                            stage=i+1 if identity[section] else None,
                            identity_verified=identity[section])
                       for i, value in enumerate(row or [])]
                for name, row in values.items()}
            if not identity[section]:
                warnings.append(f"STAGE_IDENTITY_UNVERIFIED({section})")
        # Keep raw readings above; only verified mappings enter downstream fields.
        inj = inj if identity['injection'] else dict.fromkeys(inj)
        hold = hold if identity['holding'] else dict.fromkeys(hold)
    detail["stage_identity_verified"] = identity
    # 数值推断只作候选段数；缺读不得当作零或压紧后续段位。
    n_inj = 0
    if (inj["velocity"] and inj["pressure"]
            and all(v is not None for v in inj["velocity"] + inj["pressure"])):
        for i in range(min(len(inj["velocity"]), len(inj["pressure"]))):
            if (inj["velocity"][i] or 0) > 0 or (inj["pressure"][i] or 0) > 0:
                n_inj = i + 1
    n_hold = 0
    if hold["time"] and all(v is not None for v in hold["time"]):
        for i, v in enumerate(hold["time"]):
            if (v or 0) > 0:
                n_hold = i + 1
    if holding_layout is not None:
        n_hold = holding_layout.active_stages or 0

    detail["numeric_stage_candidates"] = {"injection": n_inj or None, "holding": n_hold or None}
    verified_cells = {}
    layout_counts = {}
    for section, rows in row_cells.items():
        count = (holding_layout.active_stages if section == 'holding' and holding_layout is not None
                 else infer_active_stages(rows) if identity.get(section) else None)
        visual_count = _visual_active_count(rows[0], gray) if identity.get(section) else None
        if template.get("profile_id") != "b_and_r.injection_holding.multi_stage_position_time":
            count = visual_count if count == visual_count else None
        values = inj if section == "injection" else hold
        residual = (values["velocity"] or [])[count:] if count is not None else []
        if count is not None and visual_count is not None and visual_count != count:
            warnings.append(f"STAGE_GRAYSCALE_CONFLICT({section},layout={count},gray={visual_count})")
        conflict = count is not None and any(value is not None and value != 0 for value in residual)
        if conflict:
            warnings.append(f"STAGE_EVIDENCE_CONFLICT({section})")
        if count is not None and not conflict:
            verified_cells[section] = rows[0]
            layout_counts[section] = count
            if section == "injection":
                n_inj = count
            else:
                n_hold = count
    if n_inj == 0:
        warnings.append("STAGES_NOT_FOUND(injection)")
    if n_hold == 0:
        warnings.append("STAGES_NOT_FOUND(holding)")
    # 缺读不影响图像证实的段数；cut 仍拒绝输出缺值数组。
    # 保压切换（勾选式：位置 mm + 时间 sec）
    def switch_value(label_text, rng):
        hits = [t for t in toks
                if y_sw < t["y"] < y_sw + 0.09 and t["text"] == label_text]
        for lab in sorted(hits, key=lambda t: t["x"]):
            lo, hi = rng
            for t in sorted(toks, key=lambda t: t["x"]):
                if (abs(t["y"] - lab["y"]) <= 0.02
                        and lab["x"] < t["x"] < lab["x"] + sc["switch"]["value_dx"]):
                    v = _first_num(t["text"])
                    if v is not None and lo <= v <= hi:
                        return v, t
        return None, None

    vp_pos, vp_pos_token = switch_value(sc["switch"]["position_label"], vr["mm"])
    vp_time, vp_time_token = switch_value(sc["switch"]["time_label"], vr["s"])
    if vp_pos is None:
        warnings.append("VALUE_MISSING(vp_switch_position_mm)")
    if vp_time is None:
        warnings.append("VALUE_MISSING(vp_switch_time_s)")
    modes = []
    if vp_pos is not None:
        modes.append("位置")
    if vp_time is not None:
        modes.append("时间")
    switch_mode = "+".join(modes) if modes else None
    if switch_mode is None:
        warnings.append("VALUE_MISSING(holding_switch_mode)")

    def cut(vals, n, name):
        if vals is None or n == 0:
            return None
        got = vals[:n]
        if len(got) < n or any(v is None for v in got):
            warnings.append(f"ARRAY_INCOMPLETE({name})")
            return None
        return got

    fields = {
        "injection_velocity_pct": cut(inj["velocity"], n_inj, "injection_velocity_pct"),
        "injection_pressure_bar": cut(inj["pressure"], n_inj, "injection_pressure_bar"),
        "injection_position_mm": cut(inj["position"], n_inj, "injection_position_mm"),
        "injection_stages": n_inj or None,
        "holding_velocity_pct": cut(hold["velocity"], n_hold, "holding_velocity_pct"),
        "holding_pressure_bar": cut(hold["pressure"], n_hold, "holding_pressure_bar"),
        "holding_time_s": cut(hold["time"], n_hold, "holding_time_s"),
        "holding_stages": n_hold or None,
        "holding_switch_mode": switch_mode,
        "vp_switch_position_mm": vp_pos,
        "vp_switch_time_s": vp_time,
    }
    detail["section_y"] = {"injection": y_inj, "holding": y_hold, "switch": y_sw}
    detail["verified_layout_counts"] = layout_counts
    if template.get("profile_id") == "b_and_r.injection_holding.multi_stage_position_time":
        detail["page_variant"] = "multi_stage_position_time"
        source_tokens = {
            "injection_velocity_pct": inj_tokens.get("velocity", []),
            "injection_pressure_bar": inj_tokens.get("pressure", []),
            "injection_position_mm": inj_tokens.get("position", []),
            "holding_velocity_pct": hold_tokens.get("velocity", []),
            "holding_pressure_bar": hold_tokens.get("pressure", []),
            "holding_time_s": hold_tokens.get("time", []),
            "vp_switch_position_mm": vp_pos_token,
            "vp_switch_time_s": vp_time_token,
        }
        detail["page_observations"] = b_and_r_page_observations(
            fields, template, source_tokens,
            raw_values={
                "injection_velocity_pct": inj["velocity"], "injection_pressure_bar": inj["pressure"],
                "injection_position_mm": inj["position"], "holding_velocity_pct": hold["velocity"],
                "holding_pressure_bar": hold["pressure"], "holding_time_s": hold["time"]},
            stage_cells=verified_cells,
            layout_counts=layout_counts,
            image_path=image_path)
        # v1 consumers use the largest exposed stage as the final business stage.
        # Keep full screen facts in extraction evidence without extending that view.
        detail["raw_page_observations"] = detail["page_observations"]
        detail["page_observations"] = {
            **detail["raw_page_observations"],
            "fields": [row for row in detail["raw_page_observations"]["fields"]
                       if row["stage"] is None
                       or row["stage"] <= (fields.get(f"{row['section']}_stages") or 0)],
        }
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}


NUMBER = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*(mm/s|mm|bar|%|sec|s)?\s*$", re.I)

def observe_bole_injection(lines, meta, image_sha256, root=ROOT):
    """v2 兼容读值入口：布局给候选位置，本函数读取数值/单位，观测模块封装结果。"""
    if image_sha256 is not None and not re.fullmatch(r"[a-f0-9]{64}", image_sha256):
        raise ValueError("IMAGE_HASH_INVALID")
    package = bole_injection_package(root)
    entries, issues = build_raw_layout(lines, meta, package["raw_field_definition"], NUMBER)
    fields = []
    for entry in entries:
        spec, source_label, header = entry['spec'], entry['source_label'], entry['header']
        options, order, conflict = entry['options'], entry['order'], entry['conflict']
        cells = entry['cells']
        source = options[0] if len(options) == 1 and not conflict else None
        unit = source["match"][2] if source else None
        if source and unit is None:
            unit_cells = [c for c in cells if c["text"].lower() in {"%", "bar", "mm", "mm/s", "sec", "s"}
                          and abs(c["y"] - source["y"]) < .015 and c["x"] > source["x"]
                          and (c["x"] - source["x"] < .16 or spec.get("stage"))]
            units = {c["line"]["text"] for c in unit_cells}
            unit = next(iter(units)) if len(units) == 1 else None
        confidence = source["line"].get("conf", source["line"].get("confidence", 0)) if source else None
        reading = ("unsupported" if spec.get("value_type") == "boolean" else
                   "conflict" if conflict or len(options) > 1 else "missing" if source is None else
                   "uncertain" if confidence < .9 or source_label["text"] != spec["label"]
                   or spec.get("stage") and (header is None or header["line"].get("conf", 0) < .9) else "known")
        if unit and ("s" if unit.lower() == "sec" else unit.lower()) != spec["unit"]:
            reading = "conflict"
        field = {key: spec[key] for key in ("screen_field_key", "section", "role", "stage", "segment_id", "time_kind") if key in spec}
        field.update(source="image_recognition", original_label=source_label["line"]["text"] if source_label else None,
                     original_value=float(source["match"][1]) if source else None,
                     original_unit=unit, effective_unit=unit or spec["unit"], state="unknown", reading=reading,
                     order=order, identity_basis="ocr_header" if header else "frozen_field_definition",
                     bbox=_line_box(source["line"]) if source else None, original_bbox=None,
                     text=source["line"]["text"] if source else None, confidence=confidence,
                     reasons=["enable_state_unverified"],
                     template_ref=dict(profile_id=PROFILE, version=VERSION,
                                       sha256=package["raw_field_definition_sha256"],
                                       unit=spec["unit"] if unit is None else None))
        if reading != "known":
            issues.append(dict(code="READING_" + reading.upper(), screen_field_key=spec["screen_field_key"]))
        fields.append(field)
    return build_raw_observations(fields, issues, lines, meta, image_sha256, package)
