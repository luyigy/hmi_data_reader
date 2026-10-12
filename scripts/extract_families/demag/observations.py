"""Conservative DEMAG holding facts for the capture review contract."""


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


def metering_observations(fields: dict) -> dict:
    specs = (("stage_back_pressure_bar", "预塑背压", "bar"),
             ("stage_plasticizing_speed_rpm", "预塑转速", "rpm"),
             ("stage_position_mm", "预塑位置观测", "mm"),
             ("stage_velocity_mms", "预塑速度观测", "mm/s"))
    observations = []
    for key, label, unit in specs:
        values = fields.get(key) or []
        if len(values) > 20:
            return None
        for stage, value in enumerate(values, 1):
            observations.append({
                "label": f"{label}{stage}", "value": float(value) if value is not None else None,
                "unit": unit, "role": "setting", "section": "plasticizing", "stage": stage,
                "state": "unknown", "state_basis": None, "text": None, "confidence": 0.0,
                "bbox": None, "original_bbox": None, "line_indexes": [],
                "reasons": ["source_box_unavailable", "stage_state_unverified"],
            })
    return {"version": "1.0", "profile_id": "demag.injection_metering.multi_stage_back_pressure",
            "coordinate_space": "original_percent", "fields": observations, "stage_counts": {}}
