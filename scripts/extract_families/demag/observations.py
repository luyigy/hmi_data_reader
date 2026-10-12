"""DEMAG page observations for holding, injection, and metering review."""


def holding_observations(fields: dict) -> dict:
    specs = (
        ("stage_holding_pressure_bar", "保压压力", "bar"),
        ("stage_holding_time_s", "保压时间", "s"),
        ("stage_holding_velocity_mms", "各段保压速度", "mm/s"),
    )
    observations = []
    for key, label, unit in specs:
        values = fields.get(key) or []
        if len(values) > 20:
            return None
        for stage, value in enumerate(values, 1):
            observations.append({
                "label": f"{label}{stage}", "value": float(value) if value is not None else None,
                "unit": unit, "role": "setting", "section": "holding", "stage": stage,
                "state": "unknown", "state_basis": None, "text": None, "confidence": 0.0,
                "bbox": None, "original_bbox": None, "line_indexes": [],
                "reasons": ["source_box_unavailable", "stage_state_unverified"],
            })
    return {"version": "1.0", "profile_id": "demag.injection_metering.multi_stage_holding",
            "coordinate_space": "original_percent", "fields": observations, "stage_counts": {}}


def injection_observations(fields: dict) -> dict:
    specs = (
        ("stage_velocity_mms", "射胶速度", "mm/s", "injection", True),
        ("stage_position_mm", "射胶起点", "mm", "injection", True),
        ("injection_pressure_limit_bar", "射胶限压", "bar", "pressure", False),
        ("switch_position_mm", "VP转换位置", "mm", "scalar", False),
        ("holding_pressure_bar", "保压压力", "bar", "holding", False),
        ("holding_velocity_mms", "保压速度", "mm/s", "holding", False),
    )
    observations = []
    for key, label, unit, section, staged in specs:
        values = fields.get(key) if staged else [fields.get(key)]
        if not isinstance(values, list) or len(values) > 20:
            return None
        for stage, value in enumerate(values, 1):
            observations.append({
                "label": f"{label}{stage}" if staged else label,
                "value": float(value) if value is not None else None,
                "unit": unit, "role": "setting", "section": section,
                "stage": stage if staged else None, "state": "unknown", "state_basis": None,
                "text": None, "confidence": 0.0, "bbox": None, "original_bbox": None,
                "line_indexes": [], "reasons": ["source_box_unavailable", "stage_state_unverified"] if staged
                else ["source_box_unavailable"],
            })
    return {"version": "1.0", "profile_id": "demag.injection_metering.multi_stage_injection",
            "coordinate_space": "original_percent", "fields": observations, "stage_counts": {}}


def metering_observations(fields: dict, toks: list[dict]) -> dict:
    pressure = fields.get("stage_back_pressure_bar") or []
    rotation = fields.get("stage_plasticizing_speed_rpm") or []
    positions = fields.get("stage_position_mm") or []
    speeds = fields.get("stage_velocity_mms") or []
    rotation_labels = [t["text"].lower() for t in toks if "螺杆转速" in t["text"]]
    rotation_unit = ("mm/s" if any("mm/s" in label for label in rotation_labels) else
                     "rpm" if any("u/min" in label for label in rotation_labels) else None)
    # shortcut: the confirmed six-position layout; other layouts stay unbound until sampled.
    confirmed_layout = (len(pressure) == len(rotation) == 4 and len(positions) == 6
                        and len(speeds) == 2 and pressure[3] == 0
                        and positions[1] < positions[2] < positions[4] < positions[5])
    if confirmed_layout:
        specs = (("预塑背压", pressure[:3], "bar", True),
                 ("预塑转速", rotation[:3], rotation_unit, True),
                 ("预塑终点", positions[1:3], "mm", True),
                 ("熔料结束位置", [positions[4]], "mm", False),
                 ("后抽距离", [positions[5] - positions[4]], "mm", False),
                 ("后抽速度", [speeds[1]], "mm/s", False),
                 ("后抽目标位置", [positions[5]], "mm", False))
    else:
        specs = (("预塑原始背压", pressure, "bar", True),
                 ("预塑原始转速", rotation, rotation_unit, True),
                 ("预塑原始位置", positions, "mm", True),
                 ("预塑原始速度", speeds, "mm/s", True))
    observations = []
    for label, values, unit, staged in specs:
        if len(values) > 20:
            return None
        for stage, value in enumerate(values, 1):
            observations.append({
                "label": f"{label}{stage}" if staged else label,
                "value": float(value) if value is not None else None,
                "unit": unit, "role": "setting", "section": "plasticizing" if staged else "scalar",
                "stage": stage if staged else None,
                "state": "unknown", "state_basis": None, "text": None, "confidence": 0.0,
                "bbox": None, "original_bbox": None, "line_indexes": [],
                "reasons": ((["source_box_unavailable", "stage_state_unverified"] if staged
                             else ["source_box_unavailable"]) +
                            (["unit_unobserved"] if unit is None else [])),
            })
    return {"version": "1.0", "profile_id": "demag.injection_metering.multi_stage_back_pressure",
            "coordinate_space": "original_percent", "fields": observations, "stage_counts": {}}
