"""DEMAG physical metering page: table values and enablement evidence."""

import re

from ..common import _anchor_match
from .metering_rows import metering_row_tokens, metering_rows
from .observations import metering_observations


def build_metering_fields(toks, out, value):
    table_toks = [token for token in toks if 0.55 < token.get("y", 0) < 0.85]

    def find_row_y(keys, default_y):
        hits = [token["y"] for token in table_toks if _anchor_match(keys, token["text"])]
        return min(hits, key=lambda y: abs(y - default_y)) if hits else default_y

    rows = {
        "pressure": find_row_y(["背压[bar]", "背压"], 0.628),
        "rotation": find_row_y(["螺杆转速[U/rnin]", "螺杆转速", "转速"], 0.668),
        "position": find_row_y(["位置[mm]", "位置"], 0.708),
        "speed": find_row_y(["速度[mm/s]", "速度"], 0.746),
    }

    def row_values(y, min_x=0.40):
        candidates = sorted([(token["x"], value(token["text"])) for token in table_toks
                             if abs(token["y"] - y) <= 0.02 and token["x"] > min_x
                             and re.fullmatch(r"\d+\.?\d*", token["text"].strip())],
                            key=lambda item: item[0])
        deduped = []
        for item in candidates:
            if not deduped or item[0] - deduped[-1][0] >= 0.018:
                deduped.append(item)
            elif item[1] != deduped[-1][1] and item[0] - deduped[-1][0] > 0.01:
                deduped.append(item)
        return [number for _, number in deduped]

    pressure = row_values(rows["pressure"], min_x=0.45)
    rotation = row_values(rows["rotation"], min_x=0.45)
    position = row_values(rows["position"], min_x=0.40)
    speed = row_values(rows["speed"], min_x=0.40)
    observed = metering_rows(toks)
    if observed["stage_back_pressure_bar"] and observed["stage_plasticizing_speed_rpm"]:
        pressure = observed["stage_back_pressure_bar"]
        rotation = observed["stage_plasticizing_speed_rpm"]
        position = observed["stage_position_mm"]
        speed = observed["stage_velocity_mms"]
    return {
        "stage_back_pressure_bar": pressure,
        "stage_plasticizing_speed_rpm": rotation,
        "stage_position_mm": position,
        "stage_velocity_mms": speed,
        "first_velocity_mms": speed[0] if speed else (out["velocity"][0] if out["velocity"] else None),
        "first_position_mm": position[0] if position else (out["position"][0] if out["position"] else None),
        "pressure_limit_bar": None,
        "stage_pressure_bar": pressure,
    }


def metering_page_observations(fields, toks, img, stage_enabled):
    observations = metering_observations(fields, toks)
    if img is None or not observations or len(observations["fields"]) != 11:
        return observations
    rows = metering_row_tokens(toks)
    pressure = rows["stage_back_pressure_bar"]
    rotation = rows["stage_plasticizing_speed_rpm"]
    if len(pressure) != 4 or len(rotation) != 4:
        return observations
    states = stage_enabled(img, {
        "pressure": [(token["x"], token["y"]) for token in pressure],
        "rotation": [(token["x"], token["y"]) for token in rotation],
        "retract_position": [(token["x"], token["y"]) for token in rows["stage_position_mm"][5:6]],
        "retract_speed": [(token["x"], token["y"]) for token in rows["stage_velocity_mms"][1:2]],
    })
    if states.get("pressure") == states.get("rotation") == [True, True, True, False]:
        for field in observations["fields"]:
            if field["stage"] in (1, 2, 3):
                field["state"] = "enabled"
                field["state_basis"] = "grayscale_metering_rows_reference"
                field["reasons"] = [reason for reason in field["reasons"] if reason != "stage_state_unverified"]
        indexes = [token["line_index"] for token in pressure[:3] if "line_index" in token]
        if indexes:
            observations["stage_counts"]["plasticizing"] = {"value": 3, "line_indexes": indexes}
    if states.get("retract_position") == states.get("retract_speed") == [True]:
        for field in observations["fields"]:
            if field["label"] in ("后抽目标位置", "后抽速度") and field["value"] is not None:
                field["state"] = "enabled"
                field["state_basis"] = "grayscale_retract_cells_reference"
    return observations
