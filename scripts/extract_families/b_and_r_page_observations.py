"""Expose the B&R injection/holding physical page to the review contract."""


ROWS = {
    "injection.speed": "injection_velocity_pct",
    "injection.pressure": "injection_pressure_bar",
    "injection.end": "injection_position_mm",
    "holding.speed": "holding_velocity_pct",
    "holding.pressure": "holding_pressure_bar",
    "holding.time": "holding_time_s",
}

SCALARS = {
    "vp.position": "vp_switch_position_mm",
    "vp.switch.time": "vp_switch_time_s",
}


def b_and_r_page_observations(fields: dict, template: dict) -> dict:
    candidate = template["business_profile_candidate"]
    aliases = candidate["possible_names"]
    units = candidate["field_units"]
    observations = []
    last_injection = fields.get("injection_stages")

    def add(field_id: str, alias_id: str, value, stage: int | None):
        if value is None:
            return
        final_display = field_id == f"injection.end.{last_injection}"
        section = field_id.split(".")[0]
        observations.append(dict(
            label=aliases[alias_id][0].replace("{n}", str(stage)), value=value,
            unit=units[alias_id], role="unknown" if final_display else "setting",
            section=section if section in {"injection", "holding"} else "scalar",
            stage=stage, state="unknown", state_basis=None,
            text=str(value), confidence=0.0, bbox=None, original_bbox=None,
            line_indexes=[], reasons=["source_box_unavailable"] +
            (["stage_state_unverified"] if stage else []),
        ))

    for prefix, source in ROWS.items():
        for number, value in enumerate(fields.get(source) or [], 1):
            add(f"{prefix}.{number}", f"{prefix}.{{n}}", value, number)
    for field_id, source in SCALARS.items():
        add(field_id, field_id, fields.get(source), None)
    return dict(version="1.0", profile_id=template["profile_id"],
                coordinate_space="original_percent", fields=observations,
                stage_counts={}, visual_stage_counts={})
