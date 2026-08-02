"""EST（伯乐 EST 控制器青底 UI）射出页提取（049 阶段A A5 Z048 新增）。

布局类 KEBA，但 5/6 照片左缘裁切（压力/速度/终止位置 行标签不可见）——不用行标签，
按区段锚点切分：射出表=段头行（六段~一段）~保压位置标签；保压表=保压位置标签~说明行。
区内值 token 按 y 聚类成值行，上→下=压力/速度/终止位置[/射出时间单值/蓝底实际]（射出表）、
压力/速度/时间（保压表）；每行内值按 x 降序=段1→段N。射出时间单值行与蓝底实际行
按「值数 ≤2 且靠右 / ≥3」区分。有效段：射出=压力或速度非零最末段、保压=时间>0最末段。
返回结构同 extract_families.tact_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM = re.compile(r"\d+\.?\d*")
PCT1 = re.compile(r"^(\d{1,3}\.\d)")
PCT_STRICT = re.compile(r"^\d{1,3}\.\d+%?$")
SEG = re.compile(r"^[一二三四五六]?段$")


def _first_num(text: str) -> float | None:
    m = NUM.search(text)
    return float(m.group()) if m else None


def _pct_num(text: str) -> float | None:
    if not PCT_STRICT.match(text.strip()):
        return None
    t = text.strip().rstrip("%")
    m = PCT1.match(t)
    return float(m.group(1)) if m else _first_num(text)


def _deskew_slope(sel):
    """用首个值行（y 最小的 ~0.06 带内 token）拟合屏幕斜率 k（y = k*(x-0.5)）；
    严重斜拍时（rank05 k≈0.09）行内 y 跨度超行距，不纠斜会把相邻行粘成一簇。"""
    if len(sel) < 3:
        return 0.0
    y0 = min(t["y"] for t in sel)
    seed = [t for t in sel if t["y"] < y0 + 0.06]
    if len(seed) < 3 or max(t["x"] for t in seed) - min(t["x"] for t in seed) < 0.3:
        return 0.0
    mx = sum(t["x"] for t in seed) / len(seed)
    my = sum(t["y"] for t in seed) / len(seed)
    denom = sum((t["x"] - mx) ** 2 for t in seed)
    if denom < 1e-6:
        return 0.0
    return sum((t["x"] - mx) * (t["y"] - my) for t in seed) / denom


def _value_rows(toks, y_lo, y_hi, gap=0.015):
    sel = [t for t in toks if y_lo < t["y"] < y_hi and t["x"] > 0.15
           and _first_num(t["text"]) is not None]
    k = _deskew_slope(sel)
    for t in sel:
        t["_yc"] = t["y"] - k * (t["x"] - 0.5)
    sel.sort(key=lambda t: t["_yc"])
    clusters = []
    for t in sel:
        if clusters and t["_yc"] - clusters[-1][-1]["_yc"] <= gap:
            clusters[-1].append(t)
        else:
            clusters.append([t])
    return [sorted(cl, key=lambda t: -t["x"]) for cl in clusters]


def _row_values(cluster, rng, parse):
    """行内值按 x 降序=段1→段N；解析失败/越界的 token 视为噪声跳过（不占段槽，
    如 '9%6' 单位误识）；真正缺读的格由后续 ARRAY_INCOMPLETE 兜底进 review。"""
    lo, hi = rng
    out = []
    for t in cluster:
        v = parse(t["text"])
        if v is not None and lo <= v <= hi:
            out.append(v)
    return out


def extract_injection_est(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    vr = template["value_ranges"]
    detail: dict = {}

    # 锚点：段头行（射出表顶）、保压位置标签（射出表底/保压表顶）、说明行（保压表底）
    seg_hits = [t for t in toks if SEG.match(t["text"]) and t["y"] < 0.6]
    y_inj_top = min((t["y"] for t in seg_hits), default=None)
    vp_hits = [t for t in toks if t["text"] == "保压位置"]
    y_vp = vp_hits[0]["y"] if vp_hits else None
    note_hits = [t for t in toks if "说明" in t["text"] and t["y"] > 0.5]
    y_note = min((t["y"] for t in note_hits), default=None)
    if y_inj_top is None or y_vp is None:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ANCHOR_NOT_FOUND({y_inj_top},{y_vp})"], "detail": {}}
    y_hold_end = (y_note - 0.01) if y_note else (y_vp + 0.45)

    # 射出表：压力/速度/终止位置[/射出时间单值/蓝底实际]
    inj_rows = _value_rows(toks, y_inj_top + 0.005, y_vp - 0.02)
    inj_time = None
    if len(inj_rows) < 3:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ROW_COUNT_LOW(injection,{len(inj_rows)})"], "detail": {}}
    inj = {
        "pressure": _row_values(inj_rows[0], vr["bar"], _first_num),
        "velocity": _row_values(inj_rows[1], vr["pct"], _pct_num),
        "end_position": _row_values(inj_rows[2], vr["mm"], _first_num),
    }
    for i, cl in enumerate(inj_rows[3:], start=3):
        if len(cl) <= 2 and inj_time is None:
            v = _first_num(cl[0]["text"])
            if v is not None and vr["s"][0] <= v <= vr["s"][1]:
                inj_time = v  # 射出时间单值行（≤2 值）
    if inj_time is None:
        warnings.append("VALUE_MISSING(injection_time_s)")

    # 保压表：压力/速度/时间
    hold_rows = _value_rows(toks, y_vp + 0.02, y_hold_end)
    if len(hold_rows) < 3:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ROW_COUNT_LOW(holding,{len(hold_rows)})"], "detail": {}}
    hold = {
        "pressure": _row_values(hold_rows[0], vr["bar"], _first_num),
        "velocity": _row_values(hold_rows[1], vr["pct"], _pct_num),
        "time": _row_values(hold_rows[2], vr["s"], _first_num),
    }

    n_inj = 0
    for i in range(min(len(inj["pressure"]), len(inj["velocity"]))):
        if (inj["pressure"][i] or 0) > 0 or (inj["velocity"][i] or 0) > 0:
            n_inj = i + 1
    if n_inj == 0:
        warnings.append("STAGES_NOT_FOUND(injection)")
    n_hold = 0
    for i, v in enumerate(hold["time"]):
        if (v or 0) > 0:
            n_hold = i + 1
    if n_hold == 0:
        warnings.append("STAGES_NOT_FOUND(holding)")

    # 转保压方式（下拉文本）与保压位置值
    switch_mode = None
    for t in toks:
        if abs(t["y"] - y_vp) <= 0.04 and 0.15 < t["x"] < 0.6:
            for v in ("时间/位置", "位置", "时间"):
                if v == t["text"] or (v != "时间" and v in t["text"]):
                    switch_mode = v
                    break
        if switch_mode:
            break
    if switch_mode is None:
        warnings.append("VALUE_MISSING(holding_switch_mode)")
    vp_pos = None
    for t in sorted(toks, key=lambda t: t["x"]):
        if (abs(t["y"] - y_vp) <= 0.02 and vp_hits[0]["x"] < t["x"] < vp_hits[0]["x"] + 0.3):
            v = _first_num(t["text"])
            if v is not None and vr["mm"][0] <= v <= vr["mm"][1]:
                vp_pos = v
                break
    if vp_pos is None:
        warnings.append("VALUE_MISSING(vp_switch_position_mm)")

    def cut(vals, n, name):
        if n == 0:
            return None
        got = vals[:n]
        if len(got) < n or any(v is None for v in got):
            warnings.append(f"ARRAY_INCOMPLETE({name})")
            return None
        return got

    fields = {
        "injection_pressure_bar": cut(inj["pressure"], n_inj, "injection_pressure_bar"),
        "injection_velocity_pct": cut(inj["velocity"], n_inj, "injection_velocity_pct"),
        "injection_end_position_mm": cut(inj["end_position"], n_inj, "injection_end_position_mm"),
        "injection_stages": n_inj or None,
        "injection_time_s": inj_time,
        "holding_switch_mode": switch_mode,
        "vp_switch_position_mm": vp_pos,
        "holding_pressure_bar": cut(hold["pressure"], n_hold, "holding_pressure_bar"),
        "holding_velocity_pct": cut(hold["velocity"], n_hold, "holding_velocity_pct"),
        "holding_time_s": cut(hold["time"], n_hold, "holding_time_s"),
        "holding_stages": n_hold or None,
    }
    detail["anchor_y"] = {"inj_top": y_inj_top, "vp": y_vp, "note": y_note}
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
