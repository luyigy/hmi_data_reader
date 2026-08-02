"""B_AND_R（伯乐贝加莱 UI）射胶页提取（049 阶段A A3 Z050 新增）。

取值规则（templates/b_and_r.injection_metering.json）：射胶/保压段表行标签常被左缘
裁切——按区段头（射胶/保压/保压切换 深色条标题）切分区段，区内值 token 按 y
聚类成值行，上→下对应模板 rows 序；每行内值按 x 降序=段1→段5。射胶蓝字时间行
为实际值跳过。有效段：射胶=速度或压力非零最末段、保压=时间>0最末段。
返回结构同 extract_families.tact_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM = re.compile(r"\d+\.?\d*")


def _first_num(text: str) -> float | None:
    m = NUM.search(text)
    return float(m.group()) if m else None


def _section_y(toks, header, anchor_after=None):
    """深色条区段标题（居中 x 0.35~0.65，无固定 y 窗——照片倾斜/裁剪逐图漂移）。
    anchor_after：有多个同名命中时，取 y 大于该值中最近的一个（射胶<保压<保压切换 链式定位）。"""
    hits = [t for t in toks
            if 0.35 < t["x"] < 0.65 and _anchor_match(header, t["text"])]
    if anchor_after is not None:
        hits = [t for t in hits if t["y"] > anchor_after]
    return min(hits, key=lambda t: t["y"])["y"] if hits else None


def _value_rows(toks, y_lo, y_hi, gap):
    """区段内数值 token 按 y 聚类成值行（上→下），每行内按 x 降序=段1→段N。
    段头裸数字（'1'..'5'）排除——本页值均为 X.X 形态。"""
    sel = [t for t in toks if y_lo < t["y"] < y_hi and t["x"] > 0.1
           and _first_num(t["text"]) is not None
           and not re.fullmatch(r"\d{1,2}", t["text"].strip())]
    sel.sort(key=lambda t: t["y"])
    clusters = []
    for t in sel:
        if clusters and t["y"] - clusters[-1][-1]["y"] <= gap:
            clusters[-1].append(t)
        else:
            clusters.append([t])
    return [sorted(cl, key=lambda t: -t["x"]) for cl in clusters]


def _row_values(cluster, rng, parse):
    lo, hi = rng
    out = []
    for t in cluster:
        v = parse(t["text"])
        out.append(v if v is not None and lo <= v <= hi else None)
    return out


def extract_injection_b_and_r(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    sc = template["sections"]
    vr = template["value_ranges"]
    gap = template["cluster_gap"]
    max_stages = template["max_stages"]
    detail: dict = {}

    # 区段头 y（保压切换唯一，反向链式锚定：保压=保压切换之上最近，射胶=保压之上最近）
    y_sw = _section_y(toks, sc["switch"]["header"])
    y_hold = _section_y(toks, sc["holding"]["header"], None)
    if y_sw is not None:
        hold_hits = [t for t in toks
                     if 0.35 < t["x"] < 0.65 and t["y"] < y_sw
                     and _anchor_match(sc["holding"]["header"], t["text"])]
        y_hold = max(hold_hits, key=lambda t: t["y"])["y"] if hold_hits else None
    y_inj = None
    if y_hold is not None:
        inj_hits = [t for t in toks
                    if 0.35 < t["x"] < 0.65 and t["y"] < y_hold
                    and _anchor_match(sc["injection"]["header"], t["text"])]
        y_inj = max(inj_hits, key=lambda t: t["y"])["y"] if inj_hits else None
    if not (y_inj and y_hold and y_sw):
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"SECTION_NOT_FOUND({y_inj},{y_hold},{y_sw})"], "detail": {}}

    # 射胶表（区段：射胶头 ~ 保压头）
    inj_rows = _value_rows(toks, y_inj + 0.02, y_hold - 0.01, gap)
    inj: dict[str, list | None] = {"velocity": None, "pressure": None, "position": None}
    expect = [r for r in sc["injection"]["rows"] if r not in sc["injection"]["skip_rows"]]
    if len(inj_rows) < len(sc["injection"]["rows"]):
        warnings.append(f"ROW_COUNT_LOW(injection,{len(inj_rows)})")
    for name, cl in zip(sc["injection"]["rows"], inj_rows):
        if name in sc["injection"]["skip_rows"]:
            continue
        rng = vr["pct"] if name == "velocity" else (vr["bar"] if name == "pressure" else vr["mm"])
        inj[name] = _row_values(cl, rng, _first_num)[:max_stages]

    # 保压表（区段：保压头 ~ 保压切换头）
    hold_rows = _value_rows(toks, y_hold + 0.02, y_sw - 0.01, gap)
    hold: dict[str, list | None] = {"velocity": None, "pressure": None, "time": None}
    if len(hold_rows) < len(sc["holding"]["rows"]):
        warnings.append(f"ROW_COUNT_LOW(holding,{len(hold_rows)})")
    for name, cl in zip(sc["holding"]["rows"], hold_rows):
        rng = vr["pct"] if name == "velocity" else (vr["bar"] if name == "pressure" else vr["s"])
        hold[name] = _row_values(cl, rng, _first_num)[:max_stages]

    # 有效段
    n_inj = 0
    if inj["velocity"] and inj["pressure"]:
        for i in range(min(len(inj["velocity"]), len(inj["pressure"]))):
            if (inj["velocity"][i] or 0) > 0 or (inj["pressure"][i] or 0) > 0:
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

    # 保压切换（勾选式：位置 mm + 时间 sec）
    def switch_value(label_text, rng):
        hits = [t for t in toks
                if y_sw < t["y"] < y_sw + 0.09 and t["text"] == label_text]
        for lab in sorted(hits, key=lambda t: t["x"]):
            lo, hi = rng
            for t in sorted(toks, key=lambda t: t["x"]):
                if (abs(t["y"] - lab["y"]) <= 0.02
                        and lab["x"] < t["x"] < lab["x"] + sc["switch"]["value_dx"]):
                    v = _first_num(t["text"])
                    if v is not None and lo <= v <= hi:
                        return v
        return None

    vp_pos = switch_value(sc["switch"]["position_label"], vr["mm"])
    vp_time = switch_value(sc["switch"]["time_label"], vr["s"])
    if vp_pos is None:
        warnings.append("VALUE_MISSING(vp_switch_position_mm)")
    if vp_time is None:
        warnings.append("VALUE_MISSING(vp_switch_time_s)")
    modes = []
    if vp_pos is not None:
        modes.append("位置")
    if vp_time is not None:
        modes.append("时间")
    switch_mode = "+".join(modes) if modes else None
    if switch_mode is None:
        warnings.append("VALUE_MISSING(holding_switch_mode)")

    def cut(vals, n, name):
        if vals is None or n == 0:
            return None
        got = vals[:n]
        if len(got) < n or any(v is None for v in got):
            warnings.append(f"ARRAY_INCOMPLETE({name})")
            return None
        return got

    fields = {
        "injection_velocity_pct": cut(inj["velocity"], n_inj, "injection_velocity_pct"),
        "injection_pressure_bar": cut(inj["pressure"], n_inj, "injection_pressure_bar"),
        "injection_position_mm": cut(inj["position"], n_inj, "injection_position_mm"),
        "injection_stages": n_inj or None,
        "holding_velocity_pct": cut(hold["velocity"], n_hold, "holding_velocity_pct"),
        "holding_pressure_bar": cut(hold["pressure"], n_hold, "holding_pressure_bar"),
        "holding_time_s": cut(hold["time"], n_hold, "holding_time_s"),
        "holding_stages": n_hold or None,
        "holding_switch_mode": switch_mode,
        "vp_switch_position_mm": vp_pos,
        "vp_switch_time_s": vp_time,
    }
    detail["section_y"] = {"injection": y_inj, "holding": y_hold, "switch": y_sw}
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
