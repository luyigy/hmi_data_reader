"""EST（伯乐 EST 机台控制器，F1温度…F7返回 按键 UI）温度页提取（083 PLAN S05 新增）。

布局（templates/est.temperature.json）：上部炮筒条形图逐段当前值（仅启用段有值，
停用段图形示 0）；「设定值」行 = 左标签 + 逐段设定（停用段空白）；右侧 保温功能/
保温温度/预温计时 与 料管温度上下限偏差 单值区（整机单值，不进逐段字段）。
无段号行：列位取设定值行实测数值 x，启用段 = 从左起连续数值（相邻列距超过
1.8 倍列距中位数即视为启用段结束，右缘孤立数值如末段油温/水温设定不视为炮筒段）。
返回结构同 extract_families.kaiming_temperature。
"""
import re

from .common import _anchor_match  # noqa: F401

_NUM_RE = re.compile(r"\d+\.?\d*")


def _num(t):
    m = _NUM_RE.search(t["text"])
    return float(m.group()) if m else None


def extract_temperature_est(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    anchors = template["row_anchors"]
    rules = template["validation_rules"]
    t_lo, t_hi = rules["temperature_range_C"]

    set_l = [t for t in toks if t["x"] < 0.35 and _anchor_match(anchors["set"], t["text"])]
    if not set_l:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["ROW_ANCHORS_NOT_FOUND(set)"], "detail": {}}
    set_lab = min(set_l, key=lambda t: t["y"])
    set_y = set_lab["y"]

    # 设定行：标签右侧同行的数值 token（温度至少两位，排除段号/图标单位数字），
    # 按 x 排序取从左起连续段——相邻列距超过 1.8 倍列距中位数即启用段结束
    row = sorted([t for t in toks
                  if (v := _num(t)) is not None and v >= 10
                  and t["x"] > set_lab["x"] + 0.03
                  and (abs(t["y"] - set_y) <= 0.025
                       or (abs(t["y"] - set_y) <= 0.05
                           and re.fullmatch(r"\d{9,27}", t["text"].strip())))],
                 key=lambda t: t["x"])
    expanded = []
    glued_ranges = []
    for t in row:
        text = t["text"].strip()
        if (re.fullmatch(r"\d{9,27}", text) and len(text) % 3 == 0
                and all(t_lo <= float(text[i:i + 3]) <= t_hi
                        for i in range(0, len(text), 3))):
            chunks = [text[i:i + 3] for i in range(0, len(text), 3)]
            x0, x1 = t.get("x0", t["x"]), t.get("x1", t["x"])
            glued_ranges.append((x0, x1))
            expanded.extend({**t, "text": chunk, "_est_split": True,
                             "x": x0 + (i + 0.5) * (x1 - x0) / len(chunks)}
                            for i, chunk in enumerate(chunks))
            warnings.append(f"SET_ROW_SPLIT({text})")
        else:
            expanded.append(t)
    if glued_ranges:
        expanded = [t for t in expanded if t.get("_est_split")
                    or not any(x0 <= t["x"] <= x1 for x0, x1 in glued_ranges)]
    row = sorted(expanded, key=lambda t: t["x"])
    if len(row) < 3:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"SET_ROW_VALUES_INSUFFICIENT({len(row)})"],
                "detail": {}}
    gaps = [b["x"] - a["x"] for a, b in zip(row, row[1:])]
    med = sorted(gaps)[len(gaps) // 2]
    if not (0.02 <= med <= 0.15):
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"COLUMN_SPACING_ABNORMAL({med:.4f})"], "detail": {}}
    zones = [row[0]]
    for t, gap in zip(row[1:], gaps):
        if gap > 1.8 * med:
            warnings.append(f"SET_ROW_TRAILING_IGNORED(x={t['x']:.3f})")
            break
        zones.append(t)
    col_x = [t["x"] for t in zones]
    setv = [_num(t) for t in zones]
    n_zones = len(zones)
    col_tol = 0.5 * med

    # 当前值行：条形图逐段数值（设定行上方），按 x 吸附启用段列；
    # 停用段条形图 0 值无设定列可吸附，自动剔除
    cur = []
    cur_toks: dict[int, dict] = {}
    current_gap = 0.01 if glued_ranges else 0.03
    for t in toks:
        v = _num(t)
        if v is None or not (set_y - 0.20 < t["y"] < set_y - current_gap):
            continue
        d, j = min((abs(t["x"] - cx), i) for i, cx in enumerate(col_x))
        if d > col_tol:
            continue
        if j not in cur_toks or t["conf"] > cur_toks[j]["conf"]:
            cur_toks[j] = t
    for j in range(n_zones):
        if j in cur_toks:
            cur.append(_num(cur_toks[j]))
            if cur_toks[j]["conf"] < rules["min_cell_conf"]:
                warnings.append(f"LOW_CONF(current,段{j + 1},{cur_toks[j]['conf']:.2f})")
        else:
            cur.append(None)
            warnings.append(f"CELL_MISSING(current,段{j + 1})")

    # 保温温度：标签右侧同行的最近数值；右侧设置区多行值框（保温温度/预温计时
    # 等）在倾斜实拍上会落到邻行，先收窄到 |dy|<0.025，多候选取高置信（misread
    # 低置信），无候选再放宽到 0.04 同规则
    holding = None
    hold_l = [t for t in toks if t["x"] < 0.35
              and _anchor_match(anchors["holding"], t["text"])]
    if hold_l:
        h = hold_l[0]
        for dy_max in (0.025, 0.04):
            cands = [t for t in toks if _num(t) is not None
                     and 0.03 < t["x"] - h["x"] < 0.45 and abs(t["y"] - h["y"]) < dy_max]
            if cands:
                best = max(cands, key=lambda t: t["conf"])
                holding = _num(best)
                if best["conf"] < rules["min_cell_conf"]:
                    warnings.append(f"LOW_CONF(holding,{best['conf']:.2f})")
                break
    if holding is None:
        warnings.append("HOLDING_NOT_FOUND")

    h_lo, h_hi = rules["holding_range_C"]
    for name, vals in (("barrel_temperature_set_c", setv),
                       ("barrel_temperature_current_c", cur)):
        for i, v in enumerate(vals):
            if v is not None and not (t_lo <= v <= t_hi):
                warnings.append(f"VALUE_OUT_OF_RANGE({name}[{i}]={v})")
    if holding is not None and not (h_lo <= holding <= h_hi):
        warnings.append(f"VALUE_OUT_OF_RANGE(holding_temperature_c={holding})")

    tol_c = rules["current_set_consistency_tolerance_C"]
    for i, (cv, sv) in enumerate(zip(cur, setv)):
        if cv is not None and sv is not None and abs(cv - sv) > tol_c:
            warnings.append(f"CURRENT_SET_INCONSISTENT(段{i + 1}: {cv} vs {sv})")

    fields = {
        "barrel_temperature_set_c": setv,
        "barrel_temperature_current_c": cur,
        "holding_temperature_c": holding,
    }
    detail = {
        "zone_columns": [round(x, 4) for x in col_x],
        "set_row_y": round(set_y, 4),
        "zone_spacing": round(med, 4),
    }
    return {"fields": fields, "heater_columns": n_zones,
            "warnings": warnings, "detail": detail}
