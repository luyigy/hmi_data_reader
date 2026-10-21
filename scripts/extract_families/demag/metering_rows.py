"""Read DEMAG pre-plastication table rows across photographed screen tilt."""
import re


def metering_row_tokens(toks: list[dict]) -> dict[str, list[dict]]:
    # shortcut: calibrated on two photographed screens; expand samples before approving write targets.
    labels = {}
    for key, prefix in (("stage_back_pressure_bar", "背压"),
                        ("stage_plasticizing_speed_rpm", "螺杆转速"),
                        ("stage_position_mm", "位置"),
                        ("stage_velocity_mms", "速度")):
        matches = [t for t in toks if t["text"].startswith(prefix)
                   and 0.24 < t["x"] < 0.45 and 0.45 < t["y"] < 0.75]
        if not matches:
            return {key: [] for key in ("stage_back_pressure_bar", "stage_plasticizing_speed_rpm",
                                        "stage_position_mm", "stage_velocity_mms")}
        labels[key] = matches[0]
    numbers = [t for t in toks if t["x"] > 0.37 and 0.45 < t["y"] < 0.75
               and re.fullmatch(r"\d+\.?\d*", t["text"].strip())]
    slopes = [n / 200 for n in range(-30, 11)]
    slope = max(slopes, key=lambda k: (sum(any(abs(t["y"] - label["y"] - k * (t["x"] - label["x"])) <= 0.012
                                             for label in labels.values()) for t in numbers), -abs(k)))
    rows = {}
    for key, label in labels.items():
        matched = sorted((t for t in numbers
                          if abs(t["y"] - label["y"] - slope * (t["x"] - label["x"])) <= 0.012),
                         key=lambda t: (t["x"], t.get("src") == "ocr_variant", -t.get("conf", 0)))
        cells = []
        for token in matched:
            if cells and token["x"] - cells[-1]["x"] < 0.018:
                if (cells[-1].get("src") == "ocr_variant" and token.get("src") != "ocr_variant"):
                    cells[-1] = token
                continue
            cells.append(token)
        rows[key] = cells
    return rows


def metering_rows(toks: list[dict]) -> dict[str, list[float]]:
    return {key: [float(token["text"]) for token in row]
            for key, row in metering_row_tokens(toks).items()}
