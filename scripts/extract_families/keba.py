"""KEBA（伯乐 KePlast 灰 UI）温度页提取（026_PLAN S7 自 extract_fields.py 拆出，行为不变）。"""
from .common import _anchor_match, _fit_slope, _fit_slope_rows, _num  # noqa: F401


def extract_temperature_keba(toks: list[dict], template: dict) -> dict:
    """KEBA（伯乐 KePlast 灰 UI）温度页提取主逻辑。

    布局：上部加热段图形行 = 各段实际温度 + 右侧独立下料口温度（无行标签）；
    中部 设定温度(Z001)/温度设置(Z047)、上偏差、下偏差 三行；右侧一般设置区
    待机温度/保温温度（holding）与 油温（仅 Z001 风格）。段数动态（5 或 6）：
    列位取设定行实测数值 x，按列距中位数插补中间缺列、按行标签距离前推首部
    缺列（rank16 报警态 z1「---」-> z1 各行 null + warning）。返回同 TACT 结构。
    """
    warnings: list[str] = []
    anchors = template["row_anchors"]
    rules = template["validation_rules"]

    def find_label(keys):
        cands = [t for t in toks if _anchor_match(keys, t["text"])]
        return cands[0] if cands else None

    set_label = find_label(anchors["set"])
    high_label = find_label(anchors["high"])
    low_label = find_label(anchors["low"])
    if not (set_label and high_label and low_label):
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["ROW_ANCHORS_NOT_FOUND"], "detail": {}}
    z001_style = "设定温度" in set_label["text"]  # Z047 子变体行标签为「温度设置」，无油温

    # 两遍去斜：先用设定行+图形行数值粗拟合，再用设定行数值精拟合
    # 083 S05：粗拟合改逐行中位（混行整体最小二乘会因各行 x 分布差异虚构斜率）
    rough = [t for t in toks if _num(t) is not None and t["x"] > set_label["x"] + 0.02
             and set_label["y"] - 0.12 < t["y"] < set_label["y"] + 0.03]
    k = _fit_slope_rows(rough)
    if len(rough) < 4:
        warnings.append(f"DESKEW_INSUFFICIENT_TOKENS({len(rough)})")

    def set_row_vals() -> list[dict]:
        for t in toks:
            t["y2"] = t["y"] - k * (t["x"] - 0.5)
        return sorted([t for t in toks if _num(t) is not None
                       and t["x"] > set_label["x"] + 0.02
                       and abs(t["y2"] - set_label["y2"]) < 0.025],
                      key=lambda t: t["x"])

    set_vals = set_row_vals()
    if len(set_vals) >= 3:
        k2 = _fit_slope([{"x": t["x"], "y": t["y"]} for t in set_vals])
        if abs(k2 - k) > 0.01:
            k = k2
            set_vals = set_row_vals()
    if len(set_vals) < 4:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"SET_ROW_VALUES_INSUFFICIENT({len(set_vals)})"], "detail": {}}

    # 列位：设定行数值 x；列距中位数；中间缺列插补；首部缺列前推（rank16 z1）
    cols = [t["x"] for t in set_vals]
    diffs = [b - a for a, b in zip(cols, cols[1:])]
    sp = sorted(diffs)[len(diffs) // 2]
    if not (0.02 < sp < 0.15):
        warnings.append(f"COLUMN_SPACING_ABNORMAL({sp:.4f})")
    full = [cols[0]]
    for a, b in zip(cols, cols[1:]):
        for i in range(1, round((b - a) / sp)):
            full.append(a + sp * i)
        full.append(b)
    cols = full
    prepended = 0
    while (cols[0] - set_label["x"]) > 2.5 * sp:
        cols.insert(0, cols[0] - sp)
        prepended += 1
    if prepended:
        warnings.append(f"LEADING_COLUMNS_INFERRED({prepended})")
    n = len(cols)
    if not (4 <= n <= 8):
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ZONE_COUNT_ABNORMAL({n})"], "detail": {}}

    # 行带：标签 y2 的中点分界；图形行（current）在设定行上方 1.5~2.2 倍行距
    set_y, high_y, low_y = set_label["y2"], high_label["y2"], low_label["y2"]
    if not (set_y < high_y < low_y):
        warnings.append("ROW_ORDER_ABNORMAL")
    gap = min(high_y - set_y, low_y - high_y)
    b1, b2 = (set_y + high_y) / 2, (high_y + low_y) / 2
    bands = {
        "current": (set_y - 2.8 * gap, set_y - 0.6 * gap),
        "set": (set_y - 0.5 * gap, b1),
        "high": (b1, b2),
        "low": (b2, low_y + (low_y - b2)),
    }
    col_tol = 0.4 * sp
    cells: dict[str, dict[int, dict]] = {r: {} for r in bands}
    for r, (y0, y1) in bands.items():
        for t in toks:
            if not (y0 < t["y2"] <= y1) or _num(t) is None or t["x"] <= set_label["x"] + 0.02:
                continue
            d, i = min((abs(t["x"] - cx), i) for i, cx in enumerate(cols))
            if d <= col_tol and (i not in cells[r] or t["conf"] > cells[r][i]["conf"]):
                cells[r][i] = t

    # 下料口：图形行最后一段右侧 ~1.1 倍列距的独立值
    c0, c1 = bands["current"]
    drop_cands = [t for t in toks if c0 < t["y2"] <= c1 and _num(t) is not None
                  and cols[-1] + 0.5 * sp < t["x"] < cols[-1] + 1.8 * sp]
    drop_tok = min(drop_cands, key=lambda t: abs(t["x"] - (cols[-1] + 1.1 * sp))) if drop_cands else None
    drop = _num(drop_tok) if drop_tok else None
    if drop_tok is None:
        warnings.append("DROP_PORT_MISSING")
    elif drop_tok["conf"] < rules["min_cell_conf"]:
        warnings.append(f"LOW_CONF(drop_port,{drop_tok['conf']:.2f})")

    def row_values(row: str) -> tuple[list[float | None], list[str]]:
        vals, ws = [], []
        for i in range(n):
            t = cells[row].get(i)
            v = _num(t) if t else None
            if v is None:
                ws.append(f"CELL_MISSING({row},z{i + 1})")
            elif t["conf"] < rules["min_cell_conf"]:
                ws.append(f"LOW_CONF({row},z{i + 1},{t['conf']:.2f})")
            vals.append(v)
        return vals, ws

    cur, w1 = row_values("current")
    setv, w2 = row_values("set")
    high, w3 = row_values("high")
    low, w4 = row_values("low")
    warnings.extend(w1 + w2 + w3 + w4)

    # 保温：待机温度(Z001)/保温温度(Z047) 标签附近、范围合理的最近值
    hold_label = find_label(anchors["holding"])
    holding, hold_tok = None, None
    h_lo, h_hi = rules["holding_range_C"]
    if hold_label:
        cands = [t for t in toks if _num(t) is not None
                 and t["x"] > hold_label["x"] + 0.05
                 and abs(t["y2"] - hold_label["y2"]) < 0.06
                 and h_lo <= _num(t) <= h_hi]
        if cands:
            hold_tok = min(cands, key=lambda t: abs(t["y2"] - hold_label["y2"]))
            holding = _num(hold_tok)
            if hold_tok["conf"] < rules["min_cell_conf"]:
                warnings.append(f"LOW_CONF(holding,{hold_tok['conf']:.2f})")
        else:
            warnings.append("HOLDING_VALUE_NOT_FOUND")
    else:
        warnings.append("HOLDING_LABEL_NOT_FOUND")

    # 油温：仅 Z001 风格页面有；标签附近范围合理（20-90°C，避开防冷时间 0.0min
    # 与预热 65/35°C 等同列干扰值）的最近值；标签漏检时以待机温度标签为参照兜底
    oil, oil_tok = None, None
    o_lo, o_hi = rules["oil_range_C"]
    oil_label = find_label(anchors["oil"])
    if oil_label:
        cands = [t for t in toks if _num(t) is not None
                 and t["x"] > oil_label["x"] + 0.2
                 and abs(t["y2"] - oil_label["y2"]) < 0.06
                 and o_lo <= _num(t) <= o_hi]
        if cands:
            oil_tok = min(cands, key=lambda t: abs(t["y2"] - oil_label["y2"]))
    elif z001_style:
        if hold_label:
            cands = [t for t in toks if _num(t) is not None and t["x"] > 0.6
                     and hold_label["y2"] + 0.08 < t["y2"] < hold_label["y2"] + 0.30
                     and o_lo <= _num(t) <= o_hi]
            if cands:
                oil_tok = min(cands, key=lambda t: abs(t["y2"] - (hold_label["y2"] + 0.19)))
                warnings.append("OIL_LABEL_FALLBACK")
        if oil_tok is None:
            warnings.append("OIL_LABEL_NOT_FOUND")
    if oil_tok is not None:
        oil = _num(oil_tok)
        if oil_tok["conf"] < rules["min_cell_conf"]:
            warnings.append(f"LOW_CONF(oil,{oil_tok['conf']:.2f})")
    elif oil_label:
        warnings.append("OIL_VALUE_NOT_FOUND")

    fields = {
        "barrel_temperature_current_c": cur,
        "barrel_temperature_set_c": setv,
        "high_deviation_c": high,
        "low_deviation_c": low,
        "drop_port_temperature_current_c": drop,
        "holding_temperature_c": holding,
        "oil_temperature_current_c": oil,
    }

    # 范围校验
    t_lo, t_hi = rules["temperature_range_C"]
    d_lo, d_hi = rules["deviation_range_C"]
    for name in ("barrel_temperature_current_c", "barrel_temperature_set_c"):
        for i, v in enumerate(fields[name]):
            if v is not None and not (t_lo <= v <= t_hi):
                warnings.append(f"VALUE_OUT_OF_RANGE({name}[{i}]={v})")
    for name in ("high_deviation_c", "low_deviation_c"):
        for i, v in enumerate(fields[name]):
            if v is not None and not (d_lo <= v <= d_hi):
                warnings.append(f"VALUE_OUT_OF_RANGE({name}[{i}]={v})")
    v = fields["drop_port_temperature_current_c"]
    if v is not None and not (t_lo <= v <= t_hi):
        warnings.append(f"VALUE_OUT_OF_RANGE(drop_port_temperature_current_c={v})")

    # current vs set 一致性（±tol -> review；加热中/报警态会触发，属保守设计）
    tol_c = rules["current_set_consistency_tolerance_C"]
    for i, (cv, sv) in enumerate(zip(cur, setv)):
        if cv is not None and sv is not None and abs(cv - sv) > tol_c:
            warnings.append(f"CURRENT_SET_INCONSISTENT(z{i + 1}: {cv} vs {sv})")

    detail = {
        "columns_measured": [round(c, 4) for c in cols],
        "row_bands": {r: [round(a, 4), round(b, 4)] for r, (a, b) in bands.items()},
        "deskew_slope": round(k, 4),
        "sub_variant": "Z001" if z001_style else "Z047",
        "cells": {r: {str(i): {"text": t["text"], "conf": round(t["conf"], 3)}
                      for i, t in cells[r].items()} for r in bands},
    }
    return {"fields": fields, "heater_columns": n, "warnings": warnings, "detail": detail}
