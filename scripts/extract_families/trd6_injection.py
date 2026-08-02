"""TRD6（沙迪克）注射设定页提取（049 阶段A A6 Z020 新增）。

取值规则（templates/trd6.injection_metering.json）：标签锚点+窗口取值——
S/T 行值在标签正下方（dy +0.015~+0.055），V/P 行值在标签上方（dy -0.03~-0.09）；
保持压 T1/P1 在最右（数组按 T1→T4 即 x 降序）；单值取标签同行右侧最近数值。
有效段：注射=V 行非零计数，保压=时间>0 最末段（T 序）。
返回结构同 extract_families.tact_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM = re.compile(r"\d+\.?\d*")


def _first_num(text: str) -> float | None:
    m = NUM.search(text)
    return float(m.group()) if m else None


# OCR 形近误识候选（T1->'TI'、T3->'TS'、P1->'PI' 实测）
LABEL_VARIANTS = {
    "T1": ["T1", "TI", "Tl"],
    "T3": ["T3", "TS"],
    "P1": ["P1", "PI", "Pl"],
}


def _find_label(toks, spec, default_x=(0.0, 1.0), default_y=(0.0, 1.0)):
    x_lo, x_hi = spec.get("label_x_range", default_x)
    y_lo, y_hi = spec.get("label_y_range", default_y)
    if spec.get("label_x_min") is not None:
        x_lo = max(x_lo, spec["label_x_min"])
    if spec.get("label_x_max") is not None:
        x_hi = min(x_hi, spec["label_x_max"])
    if spec.get("label_y_min") is not None:
        y_lo = max(y_lo, spec["label_y_min"])
    hits = [t for t in toks
            if x_lo <= t["x"] <= x_hi and y_lo <= t["y"] <= y_hi
            and _anchor_match(spec["label"], t["text"])]
    return sorted(hits, key=lambda t: (t["y"], t["x"]))


def _col_value(toks, lab, dy_lo, dy_hi, dx, rng):
    """列窗取值：dy 带（正=标签下方，负=上方）+ |x-lab.x|<=dx 内最近数值。"""
    lo, hi = rng
    best = None
    for t in toks:
        dy = t["y"] - lab["y"]
        if not (dy_lo <= dy <= dy_hi and abs(t["x"] - lab["x"]) <= dx):
            continue
        v = _first_num(t["text"])
        if v is None or not (lo <= v <= hi):
            continue
        d = abs(t["x"] - lab["x"]) + abs(dy)
        if best is None or d < best[0]:
            best = (d, v)
    return best[1] if best else None


def extract_injection_trd6(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    arrays = template["arrays"]
    singles = template["singles"]
    detail: dict = {}
    raw: dict[str, list | float | None] = {}

    for name, spec in arrays.items():
        labs = []
        for lab_text in spec["labels"]:
            cands = LABEL_VARIANTS.get(lab_text, [lab_text])
            hits = _find_label(toks, {**spec, "label": cands})
            labs.append(hits[0] if hits else None)
        # 标签整枚漏检：用兄弟标签按列间距外推（T1/P1 在最右，rank02 实测 T1 漏检）
        found = [(i, l) for i, l in enumerate(labs) if l is not None]
        if found and len(found) < len(labs):
            xs = sorted(l["x"] for _, l in found)
            spacings = [b - a for a, b in zip(xs, xs[1:])]
            spacing = sorted(spacings)[len(spacings) // 2] if spacings else 0.078
            for i, lab_text in enumerate(spec["labels"]):
                if labs[i] is not None:
                    continue
                right = [l for j, l in found if j > i]
                left = [l for j, l in found if j < i]
                if right:
                    labs[i] = {"x": max(l["x"] for l in right) + spacing,
                               "y": right[0]["y"], "text": lab_text, "conf": 0.0,
                               "src": "extrapolated"}
                elif left:
                    labs[i] = {"x": min(l["x"] for l in left) - spacing,
                               "y": left[-1]["y"], "text": lab_text, "conf": 0.0,
                               "src": "extrapolated"}
        raw[name] = [None if lab is None else
                     _col_value(toks, lab, *spec["value_dy"], spec["dx"], spec["range"])
                     for lab in labs]

    # 段数：注射=V 行非零计数；保压=时间>0 最末段（T1→T4 序）
    vel = raw["injection_velocity_mms"] or []
    n_inj = sum(1 for v in vel if (v or 0) > 0)
    if n_inj == 0:
        warnings.append("STAGES_NOT_FOUND(injection)")
    ht = raw["holding_time_s"] or []
    n_hold = 0
    for i, v in enumerate(ht):
        if (v or 0) > 0:
            n_hold = i + 1
    if n_hold == 0:
        warnings.append("STAGES_NOT_FOUND(holding)")

    # 数组缺值告警只针对有效段内（末段未启用段的空值不告警）
    for name, n in (("injection_positions_mm", n_inj), ("injection_velocity_mms", n_inj),
                    ("holding_time_s", n_hold), ("holding_pressure_mpa", n_hold)):
        vals = raw.get(name) or []
        miss = sum(1 for v in vals[:n] if v is None)
        if miss:
            warnings.append(f"ARRAY_VALUE_MISSING({name},{miss})")

    # 计量位置：'计量' 标签漏检时用 S1 标签右侧窗兜底（rank06 实测）
    if raw.get("metering_position_mm") == [None]:
        spec = arrays["metering_position_mm"]
        s1 = _find_label(toks, {"label": "S1"})
        if s1:
            lo, hi = spec["range"]
            for t in toks:
                dy = t["y"] - s1[0]["y"]
                if (spec["value_dy"][0] <= dy <= spec["value_dy"][1]
                        and s1[0]["x"] + 0.03 < t["x"] < s1[0]["x"] + 0.13):
                    v = _first_num(t["text"])
                    if v is not None and lo <= v <= hi:
                        raw["metering_position_mm"] = [v]
                        break

    for name, spec in singles.items():
        lo, hi = spec["range"]
        got = None
        for lab in _find_label(toks, spec):
            dy = spec.get("dy", 0.025)
            for t in sorted(toks, key=lambda t: t["x"]):
                if (abs(t["y"] - lab["y"]) <= dy
                        and lab["x"] < t["x"] < lab["x"] + spec["dx"]):
                    v = _first_num(t["text"])
                    if v is not None and lo <= v <= hi:
                        got = v
                        break
            if got is not None:
                break
        raw[name] = got
        if got is None:
            warnings.append(f"VALUE_MISSING({name})")

    def cut(name, n):
        vals = raw.get(name)
        if not vals or n == 0:
            return None
        got = vals[:n]
        if len(got) < n or any(v is None for v in got):
            warnings.append(f"ARRAY_INCOMPLETE({name})")
            return None
        return got

    fields = {
        "injection_positions_mm": cut("injection_positions_mm", n_inj),
        "injection_velocity_mms": cut("injection_velocity_mms", n_inj),
        "injection_stages": n_inj or None,
        "metering_position_mm": (raw["metering_position_mm"] or [None])[0],
        "pressure_limit_mpa": raw["pressure_limit_mpa"],
        "injection_time_limit_s": raw["injection_time_limit_s"],
        "vp_switch_mode": template["switch_mode_constant"],
        "vp_switch_position_mm": raw["vp_switch_position_mm"],
        "holding_pressure_mpa": cut("holding_pressure_mpa", n_hold),
        "holding_time_s": cut("holding_time_s", n_hold),
        "holding_stages": n_hold or None,
        "holding_velocity_mms": raw["holding_velocity_mms"],
        "cooling_time_s": raw["cooling_time_s"],
        "dwell_time_s": raw["dwell_time_s"],
        "injection_delay_s": raw["injection_delay_s"],
        "metering_delay_s": raw["metering_delay_s"],
        "metering_rpm": raw["metering_rpm"],
        "back_pressure_mpa": raw["back_pressure_mpa"],
        "suckback_mm": raw["suckback_mm"],
        "suckback_speed_pct": raw["suckback_speed_pct"],
        "purge_velocity_mms": raw["purge_velocity_mms"],
        "purge_count": raw["purge_count"],
    }
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
