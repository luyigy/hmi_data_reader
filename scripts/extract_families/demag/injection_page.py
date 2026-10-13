"""DEMAG physical injection page: confirmed values and physical stage order."""


def build_injection_fields(toks, rows, template, warnings, out,
                           speed_values, position_values, global_pressure):
    return {
        "holding_pressure_bar": out["pressure"][0] if out["pressure"] else None,
        "holding_velocity_mms": out["velocity"][0] if out["velocity"] else None,
        "switch_position_mm": out["position"][0] if out["position"] else None,
        "stage_velocity_mms": speed_values,
        "stage_position_mm": position_values,
        "injection_pressure_limit_bar": global_pressure(toks, rows["pressure"], template, warnings),
    }


def normalize_injection_stages(fields, stage_enabled, warnings):
    for key in ("stage_velocity_mms", "stage_position_mm"):
        values = fields.get(key)
        if not isinstance(values, list):
            continue
        enabled = stage_enabled.get(key)
        use_enabled = enabled is not None and len(enabled) == len(values)
        if use_enabled:
            kept = [(number, active) for number, active in zip(values, enabled) if active]
            values = [number for number, _ in kept]
            enabled = [active for _, active in kept]
        elif values:
            warnings.append(f"STAGE_ENABLED_UNVERIFIED({key})")
        fields[key] = list(reversed(values))
        if enabled is not None:
            stage_enabled[key] = list(reversed(enabled))
