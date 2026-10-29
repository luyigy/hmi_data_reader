"""Expose the B&R injection/holding physical page to the review contract."""

import cv2

from .common import bbox_grayscale_contrast


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


def _visual_active_count(tokens: list[dict], gray) -> int | None:
    """Accept a single clear bright-to-gray boundary in the speed value row."""
    if gray is None or len(tokens) < 3 or any(token.get("conf", 0) < .8 for token in tokens):
        return None
    contrasts = [bbox_grayscale_contrast(gray, token.get("bbox")) for token in tokens]
    if any(value is None for value in contrasts):
        return None
    candidates = [split for split in range(1, len(tokens))
                  if min(contrasts[:split]) - max(contrasts[split:]) >= 25
                  and min(contrasts[:split]) >= 1.2 * max(contrasts[split:])]
    return candidates[0] if len(candidates) == 1 else None


def b_and_r_page_observations(fields: dict, template: dict, source_tokens: dict | None = None,
                              *, stage_tokens: dict | None = None, image_path=None) -> dict:
    candidate = template["business_profile_candidate"]
    aliases = candidate["possible_names"]
    units = candidate["field_units"]
    observations = []
    last_injection = fields.get("injection_stages")
    source_tokens = source_tokens or {}
    gray = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE) if image_path is not None else None
    visual_counts = {section: count for section, tokens in (stage_tokens or {}).items()
                     if (count := _visual_active_count(tokens, gray)) is not None
                     and count == fields.get(f"{section}_stages")}

    def add(field_id: str, alias_id: str, value, stage: int | None, token: dict | None):
        if value is None:
            return
        final_display = field_id == f"injection.end.{last_injection}"
        section = field_id.split(".")[0]
        box = token.get("bbox") if token else None
        verified = stage is not None and stage <= visual_counts.get(section, 0)
        observations.append(dict(
            label=aliases[alias_id][0].replace("{n}", str(stage)), value=value,
            unit=units[alias_id], role="unknown" if final_display else "setting",
            section=section if section in {"injection", "holding"} else "scalar",
            stage=stage, state="enabled" if verified else "unknown",
            state_basis="grayscale_stage_boundary" if verified else None,
            text=token["text"] if token else str(value),
            confidence=token.get("conf", 0.0) if token else 0.0,
            bbox=box, original_bbox=None,
            line_indexes=[], reasons=(["source_box_unavailable"] if box is None else []) +
            (["stage_state_unverified"] if stage and not verified else []),
        ))

    for prefix, source in ROWS.items():
        for number, value in enumerate(fields.get(source) or [], 1):
            tokens = source_tokens.get(source) or []
            add(f"{prefix}.{number}", f"{prefix}.{{n}}", value, number,
                tokens[number - 1] if number <= len(tokens) else None)
    for field_id, source in SCALARS.items():
        add(field_id, field_id, fields.get(source), None, source_tokens.get(source))
    return dict(version="1.0", profile_id=template["profile_id"],
                coordinate_space="original_percent", fields=observations,
                stage_counts={}, visual_stage_counts={k: v for k, v in visual_counts.items() if k == "injection"})
