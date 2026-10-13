"""DEMAG physical holding page: field rows and physical stage order."""

import re


def build_holding_fields(toks, row_of, tolerance, dedupe, variant_source, value,
                         pressure_values, speed_values, warnings):
    time_cells = dedupe(sorted(
        ((t["x"], value(t["text"]), variant_source(t)) for t in toks
         if abs(t["y"] - row_of("position")) <= tolerance and t["x"] > 0.45
         and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
        key=lambda item: item[0]), "holding.time_row")
    time_values = [number for _, number, _ in time_cells]
    fields = {
        "stage_holding_pressure_bar": pressure_values,
        "stage_holding_time_s": time_values,
        "stage_holding_velocity_mms": speed_values,
    }
    for key, values in fields.items():
        if not values:
            warnings.append(f"CELL_MISSING({key})")
    return fields, time_cells


def normalize_holding_stages(fields, stage_enabled, warnings):
    for key in ("stage_holding_pressure_bar", "stage_holding_time_s",
                "stage_holding_velocity_mms"):
        values = fields.get(key)
        if not isinstance(values, list):
            continue
        enabled = stage_enabled.get(key)
        use_enabled = enabled is not None and len(enabled) == len(values)
        if use_enabled:
            kept = [(number, active) for number, active in zip(values, enabled) if active]
            values = [number for number, _ in kept]
            enabled = [active for _, active in kept]
        else:
            if values:
                warnings.append(f"STAGE_ENABLED_UNVERIFIED({key})")
            while values and values[0] == 0:
                values = values[1:]
                if enabled:
                    enabled = enabled[1:]
        fields[key] = list(reversed(values))
        if enabled is not None:
            stage_enabled[key] = list(reversed(enabled))
    speeds = fields.get("stage_holding_velocity_mms")
    if isinstance(speeds, list) and len(speeds) == 1:
        fields["holding_velocity_mms"] = speeds[0]
