"""Expose the B&R injection/holding physical page to the review contract."""

import cv2

from .visual_cells import cell_glyph_evidence


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


def _visual_active_count(cells: list, gray) -> int | None:
    """B&R semantics: one verified dark-to-gray boundary on physical cells.

    OCR confidence and token count cannot establish cell visibility. The same
    physical image yields the same state evidence even when OCR misses text.
    """
    if gray is None or not cells:
        return None
    evidence = [cell_glyph_evidence(gray, box) for box in cells]
    if any(item is None or item["contrast"] is None for item in evidence):
        return None
    contrasts = [item["contrast"] for item in evidence]
    candidates = [split for split in range(1, len(cells))
                  if min(contrasts[:split]) - max(contrasts[split:]) >= 25
                  and min(contrasts[:split]) >= 1.2 * max(contrasts[split:])]
    return candidates[0] if len(candidates) == 1 else None


def b_and_r_page_observations(fields: dict, template: dict, source_tokens: dict | None = None,
                              *, stage_cells: dict | None = None,
                              raw_values: dict | None = None, image_path=None) -> dict:
    candidate = template["business_profile_candidate"]
    aliases = candidate["possible_names"]
    units = candidate["field_units"]
    observations = []
    last_injection = fields.get("injection_stages")
    source_tokens = source_tokens or {}
    gray = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE) if image_path is not None else None
    visual_counts = {section: count for section, cells in (stage_cells or {}).items()
                     if (count := _visual_active_count(cells, gray)) is not None
                     and count == fields.get(f"{section}_stages")}

    def add(field_id: str, alias_id: str, value, stage: int | None, token: dict | None):
        if value is None:
            return
        final_display = field_id == f"injection.end.{last_injection}"
        section = field_id.split(".")[0]
        box = token.get("bbox") if token else None
        verified = (stage is not None and stage <= visual_counts.get(section, 0)
                    and token is not None and token.get("conf", 0) >= .8
                    and box is not None)
        disabled = stage is not None and section in visual_counts and stage > visual_counts[section]
        state = "enabled" if verified else "disabled" if disabled else "unknown"
        observations.append(dict(
            label=aliases[alias_id][0].replace("{n}", str(stage)), value=value,
            unit=units[alias_id], role="unknown" if final_display else "setting",
            section=section if section in {"injection", "holding"} else "scalar",
            stage=stage, state=state,
            state_basis="grayscale_stage_boundary" if stage and section in visual_counts else None,
            text=token["text"] if token else str(value),
            confidence=token.get("conf", 0.0) if token else 0.0,
            bbox=box, original_bbox=None,
            line_indexes=[token["line_index"]] if token and "line_index" in token else [], reasons=(["source_box_unavailable"] if box is None else []) +
            (["stage_state_unverified"] if stage and state == "unknown" else []) +
            (["low_confidence"] if not token or token.get("conf", 0) < .8 else []),
        ))

    for prefix, source in ROWS.items():
        for number, value in enumerate((raw_values or fields).get(source) or [], 1):
            tokens = source_tokens.get(source) or []
            add(f"{prefix}.{number}", f"{prefix}.{{n}}", value, number,
                tokens[number - 1] if number <= len(tokens) else None)
    for field_id, source in SCALARS.items():
        add(field_id, field_id, fields.get(source), None, source_tokens.get(source))
    return dict(version="1.0", profile_id=template["profile_id"],
                coordinate_space="original_percent", fields=observations,
                stage_counts={}, visual_stage_counts={k: v for k, v in visual_counts.items() if k == "injection"})
