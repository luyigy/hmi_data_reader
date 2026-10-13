"""Expose the Z036 physical page's extracted settings to the review contract.

Legacy extraction has values but no per-cell source boxes. Keep that uncertainty
visible so the capture UI requires a person to check the original image.
"""

FIELD_SOURCES = {
    "injection.speed": "injection_velocity_mms",
    "injection.pressure": "injection_pressure_limit_mpa",
    "holding.pressure": "holding_pressure_mpa",
    "holding.time": "holding_time_s",
    "plasticizing.pressure": "metering_back_pressure_mpa",
    "plasticizing.speed": "metering_rpm_stages",
    "plasticizing.end": "metering_switch_positions_mm",
}

SCALARS = {
    "injection.end.1": "injection_switch_position_mm",
    "vp.position": "vp_switch_position_mm",
    "holding.speed.shared": "holding_limit_speed_mms",
    "injection.time.limit": "max_injection_time_s",
    "injection.alarm.pressure": "injection_alarm_pressure_mpa",
    "plasticizing.manual_back_pressure": "back_pressure_mpa",
    "plasticizing.manual_rpm": "metering_rpm",
    "metering.end": "metering_position_mm",
    "retract.post.distance": "decompress_position_mm",
    "retract.post.speed": "decompress_mms",
    "cooling.time": "cooling_time_s",
}

OBSERVATION_ONLY = {
    "injection.time.limit", "injection.alarm.pressure",
    "plasticizing.manual_back_pressure", "plasticizing.manual_rpm",
}


def fanuc_page_observations(fields: dict, template: dict) -> dict:
    candidate = template["business_profile_candidate"]
    aliases = candidate["possible_names"]
    units = candidate["field_units"]
    observations = []

    def add(field_id: str, alias_id: str, value):
        if value is None:
            return
        section = field_id.split(".")[0]
        stage = int(field_id.rsplit(".", 1)[1]) if field_id.rsplit(".", 1)[-1].isdigit() else None
        if alias_id not in aliases and stage is not None:
            alias_id = field_id.rsplit(".", 1)[0] + ".{n}"
        section = section if section in {"injection", "holding", "plasticizing"} else "scalar"
        label = aliases[alias_id][0].replace("{n}", str(stage))
        observations.append(dict(
            label=label, value=value, unit=units[alias_id],
            role="unknown" if field_id in OBSERVATION_ONLY else "setting",
            section=section, stage=stage, state="unknown", state_basis=None,
            text=str(value), confidence=0.0, bbox=None, original_bbox=None,
            line_indexes=[], reasons=["source_box_unavailable", "stage_state_unverified"]
            if stage else ["source_box_unavailable"],
        ))

    for prefix, source in FIELD_SOURCES.items():
        for number, value in enumerate(fields.get(source) or [], 1):
            add(f"{prefix}.{number}", f"{prefix}.{{n}}", value)
    for field_id, source in SCALARS.items():
        add(field_id, field_id, fields.get(source))
    return dict(version="1.0", profile_id=template["profile_id"],
                coordinate_space="original_percent", fields=observations,
                stage_counts={}, visual_stage_counts={})
