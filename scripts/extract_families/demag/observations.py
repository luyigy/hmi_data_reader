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
