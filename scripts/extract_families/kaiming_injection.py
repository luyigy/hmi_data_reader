"""KAIMING（佳明开明控制器）射出页提取（049 阶段A A4 Z062 新增）。

取值规则（templates/kaiming.injection_metering.json）：行标签为竖排文字 OCR 合并
（'压速时位'）不可靠——按区段锚点（转保压/射出位置）切分射出表/保压表，区内值
token 按 y 聚类成值行，上→下对应模板 rows 序；每行内值按 x 降序=段1→段N
（位置行与压力行列 x 有 0.07 错位，按列中心归段会错，必须行内序归段）。
灰底时间行=实际值跳过。有效段：射出=压力或速度非零最末段、保压=时间>0最末段。
返回结构同 extract_families.tact_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM = re.compile(r"\d+\.?\d*")


def _first_num(text: str) -> float | None:
    m = NUM.search(text)
    return float(m.group()) if m else None


def _anchor_y(toks, text, x_max, y_lo=0.2, y_hi=0.9):
    # 子串匹配：'转保压'常与'位置'粘成 '转保压位置'
    hits = [t for t in toks
            if t["x"] < x_max and y_lo < t["y"] < y_hi and text in t["text"]]
    return hits[0]["y"] if hits else None


def _value_rows(toks, y_lo, y_hi, gap):
    """区段内数值 token 按 y 聚类成值行（上→下），每行内按 x 降序=段1→段N。"""
    sel = [t for t in toks if y_lo < t["y"] < y_hi and t["x"] > 0.3
           and _first_num(t["text"]) is not None]
    sel.sort(key=lambda t: t["y"])
    clusters = []
    for t in sel:
        if clusters and t["y"] - clusters[-1][-1]["y"] <= gap:
            clusters[-1].append(t)
        else:
            clusters.append([t])
    return [sorted(cl, key=lambda t: -t["x"]) for cl in clusters]


def _row_values(cluster, rng):
    lo, hi = rng
    out = []
    for t in cluster:
        v = _first_num(t["text"])
        out.append(v if v is not None and lo <= v <= hi else None)
    return out


def extract_injection_kaiming(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    sc = template["sections"]
    vr = template["value_ranges"]
    gap = template["cluster_gap"]
    max_stages = template["max_stages"]
    detail: dict = {}

    y_switch = _anchor_y(toks, sc["injection"]["end_anchor"],
                         sc["injection"]["end_anchor_x_max"])
    y_bottom = _anchor_y(toks, sc["holding"]["end_anchor"],
                         sc["holding"]["end_anchor_x_max"], y_lo=0.6, y_hi=0.95)
    if y_switch is None or y_bottom is None:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ANCHOR_NOT_FOUND({y_switch},{y_bottom})"], "detail": {}}

    # 射出表（页面上半 ~ 转保压行）
    inj_rows = _value_rows(toks, 0.25, y_switch - 0.01, gap)
    inj: dict[str, list | None] = {"pressure": None, "velocity": None, "position": None}
    if len(inj_rows) < len(sc["injection"]["rows"]):
        warnings.append(f"ROW_COUNT_LOW(injection,{len(inj_rows)})")
    for name, cl in zip(sc["injection"]["rows"], inj_rows):
        if name in sc["injection"]["skip_rows"]:
            continue
        rng = vr["bar"] if name == "pressure" else (vr["pct"] if name == "velocity" else vr["mm"])
        inj[name] = _row_values(cl, rng)[:max_stages]

    # 保压表（转保压行 ~ 底部实时行；转保压值行（位置mm/时间sec）须排除在区外）
    hold_rows = _value_rows(toks, y_switch + 0.045, y_bottom - 0.01, gap)
    hold: dict[str, list | None] = {"pressure": None, "velocity": None, "time": None}
    if len(hold_rows) < len(sc["holding"]["rows"]):
        warnings.append(f"ROW_COUNT_LOW(holding,{len(hold_rows)})")
    for name, cl in zip(sc["holding"]["rows"], hold_rows):
        rng = vr["bar"] if name == "pressure" else (vr["pct"] if name == "velocity" else vr["s"])
        hold[name] = _row_values(cl, rng)[:max_stages]

    # 有效段
    n_inj = 0
    if inj["pressure"] and inj["velocity"]:
        for i in range(min(len(inj["pressure"]), len(inj["velocity"]))):
            if (inj["pressure"][i] or 0) > 0 or (inj["velocity"][i] or 0) > 0:
                n_inj = i + 1
    if n_inj == 0:
        warnings.append("STAGES_NOT_FOUND(injection)")
    n_hold = 0
    if hold["time"]:
        for i, v in enumerate(hold["time"]):
            if (v or 0) > 0:
                n_hold = i + 1
    if n_hold == 0:
        warnings.append("STAGES_NOT_FOUND(holding)")

    # 转保压行：位置 mm + 时间 sec（'Bar位置' 常粘成单 token）
    sw = sc["switch"]
    band = [t for t in toks if abs(t["y"] - y_switch) <= 0.03]

    def _switch_val(x_lo, x_hi, rng):
        lo, hi = rng
        for t in sorted(band, key=lambda t: t["x"]):
            if x_lo <= t["x"] <= x_hi:
                v = _first_num(t["text"])
                if v is not None and lo <= v <= hi:
                    return v
        return None

    vp_pos = _switch_val(*sw["position_value_x_range"], vr["mm"])
    vp_time = _switch_val(*sw["time_value_x_range"], vr["s"])
    if vp_pos is None:
        warnings.append("VALUE_MISSING(vp_switch_position_mm)")
    if vp_time is None:
        warnings.append("VALUE_MISSING(vp_switch_time_s)")

    def cut(vals, n, name, fill_zero=False):
        if vals is None or n == 0:
            return None
        got = list(vals[:n])
        if len(got) < n:
            if fill_zero:
                got += [0.0] * (n - len(got))  # 末段位置空白记 0.0（位置行末段常空白）
            else:
                warnings.append(f"ARRAY_INCOMPLETE({name})")
                return None
        if any(v is None for v in got):
            warnings.append(f"ARRAY_INCOMPLETE({name})")
            return None
        return got

    fields = {
        "injection_pressure_bar": cut(inj["pressure"], n_inj, "injection_pressure_bar"),
        "injection_velocity_pct": cut(inj["velocity"], n_inj, "injection_velocity_pct"),
        "injection_position_mm": cut(inj["position"], n_inj, "injection_position_mm", fill_zero=True),
        "injection_stages": n_inj or None,
        "holding_switch_mode": sw["mode_constant"],
        "vp_switch_position_mm": vp_pos,
        "vp_switch_time_s": vp_time,
        "holding_pressure_bar": cut(hold["pressure"], n_hold, "holding_pressure_bar"),
        "holding_velocity_pct": cut(hold["velocity"], n_hold, "holding_velocity_pct"),
        "holding_time_s": cut(hold["time"], n_hold, "holding_time_s"),
        "holding_stages": n_hold or None,
    }
    detail["anchor_y"] = {"switch": y_switch, "bottom": y_bottom}
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
