"""FANUC（发那科 ROBOSHOT 蓝灰 UI）喷嘴/料筒温度页提取（026_PLAN S7 新增）。

布局（templates/fanuc.temperature.json）：行 = 现在(实际)/输出%/上限/设定/下限；
列取数据行最右 5 个数值（N/B1/B2/B3/H，M1-M4 模具加热未启用不提取）。
现在行数值常粘连成单 token（如 #***#*****339.9335.1335.0335.0），按 \\d+\\.\\d 切分。
返回结构同 extract_families.keba。
"""
import re

from .common import _anchor_match, _fit_slope, _num  # noqa: F401

NUM_FULL = re.compile(r"-?\d+\.\d+|-?\d+")


def _split_nums(text: str) -> list[float]:
    """从 token 文本切数值：'90-3'->90.3（OCR 点成横）；丢点融合 '3350334.6'->335.0+334.6。
    严格形态：整数位 2~3 + 1 位小数（本页数值全为该形态；M1-M4 的 0.0 不匹配会被自然
    排除——表区行取最右 5 列不受影响，但输出行 0.x 小数值需注意）。"""
    t = text.strip()
    t = re.sub(r"(\d)-(\d)", r"\1.\2", t)  # OCR 点成横：'90-3'->90.3、'50-0oC'->50.0oC
    t = re.sub(r"(\d{2,3})(\d)(?=\d{2,3}\.\d)", r"\1.\2", t)
    return [float(m) for m in re.findall(r"\d{2,3}\.\d", t)]


def _clean_num(text: str) -> float | None:
    """清洗 OCR 数值：'90-3'->90.3、'31.8X'->31.8、'50.0°℃'->50.0。"""
    vals = _split_nums(text)
    return vals[0] if vals else None


def _row_values(toks, y, k, x_lo=0.25, x_hi=0.7, tol=0.018):
    """某行 y（按斜率 k 修正）附近的数值 token，按 x 排序；粘连 token 切分后同位展开。"""
    band = [t for t in toks
            if abs(t["y"] - (y + k * (t["x"] - 0.5))) < tol and x_lo < t["x"] < x_hi]
    out = []
    for t in sorted(band, key=lambda t: t["x"]):
        for v in _split_nums(t["text"]):
            out.append((t["x"], v, t))
    return out


def _rightmost5(vals, row_name, warnings):
    if len(vals) < 5:
        warnings.append(f"ROW_VALUES_MISSING({row_name},{len(vals)}/5)")
        return None
    return [v for _, v, _ in vals[-5:]]


def extract_temperature_fanuc(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    anchors = template["row_anchors"]
    rules = template["validation_rules"]

    def find_label(keys, xmax=0.25):
        cands = [t for t in toks if t["x"] < xmax and _anchor_match(keys, t["text"])]
        return min(cands, key=lambda t: t["y"]) if cands else None

    lab = {r: find_label(anchors[r]) for r in ("current", "control", "high", "set", "low")}
    if not (lab["set"] and lab["high"] and lab["low"]):
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["ROW_ANCHORS_NOT_FOUND"], "detail": {}}
    if not lab["current"]:
        warnings.append("ROW_ANCHOR_MISSING(current)")
    if not lab["control"]:
        warnings.append("ROW_ANCHOR_MISSING(control)")

    # 内容锚定行网格：设定行是表区唯一含 ≥3 个 ≥100 数值的行（行值域约束），
    # 找到后按行距（标签实测，缺省用模板均值）向上下展开 上限/下限/输出/现在。
    # 不依赖标签与数值的纵向对齐（倾斜暗图错位可达 0.05）。
    def find_set_y():
        # 扫描范围限定在上/下限标签之间（排除 现在 行粘连 blob 的同值域干扰）；
        # 按切分后 ≥100 的「值」计数（设定行 mega 粘连 token 也能积满 3）
        y_lo = lab["high"]["y"] - 0.01
        y_hi = lab["low"]["y"] + 0.01
        best, best_n = None, 0
        y = y_lo
        hits = []
        while y < y_hi:
            band = [t for t in toks if abs(t["y"] - y) < 0.018 and 0.25 < t["x"] < 0.7]
            n = sum(1 for t in band for v in _split_nums(t["text"]) if v >= 100)
            hits.append((y, n))
            if n > best_n:
                best_n = n
            y += 0.004
        if best_n < 3:
            return None
        plateau = [y for y, n in hits if n == best_n]
        return sum(plateau) / len(plateau)  # 平台中心，而非首个命中

    set_y = find_set_y()
    if set_y is None:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["SET_ROW_NOT_FOUND"], "detail": {}}

    g = (lab["low"]["y"] - lab["high"]["y"]) / 2
    g_out = lab["high"]["y"] - lab["control"]["y"] if lab["control"] else g
    g_cur = lab["control"]["y"] - lab["current"]["y"] if lab["control"] else g
    high_y, low_y = set_y - g, set_y + g
    control_y = high_y - g_out
    current_y = control_y - g_cur

    rows = {}
    for r, ry in (("high", high_y), ("set", set_y), ("low", low_y)):
        vals = _row_values(toks, ry, 0)
        if len(vals) == 4:
            # 边缘列（多为 H）略出行带：放宽一档补一次
            vals2 = _row_values(toks, ry, 0, tol=0.028)
            if len(vals2) >= 5:
                vals = vals2
        rows[r] = _rightmost5(vals, r, warnings)

    # 现在行：本行唯一多值粘连块是 N..B3 温度 blob（M1-M4 为 *****、H 为独立 token）。
    # 逐 token 切分并值域过滤，取有效值最多的 token 的末 4 值为 N,B1,B2,B3；
    # H 取该 blob 右侧的单值 token。
    cur_barrel = cur_h = None
    band = [t for t in toks if abs(t["y"] - current_y) < 0.02 and 0.2 < t["x"] < 0.7]
    cands = []
    for t in sorted(band, key=lambda t: t["x"]):
        vals = [v for v in _split_nums(t["text"]) if 0 <= v <= 400]
        if vals:
            cands.append((t, vals))
    if cands:
        best_t, best_v = max(cands, key=lambda e: (len(e[1]), e[0]["conf"]))
        if len(best_v) >= 4:
            cur_barrel = best_v[-4:]
            if len(_split_nums(best_t["text"])) > 1:
                warnings.append("CURRENT_ROW_GLUED_SPLIT")
            for t, vals in cands:
                if t["x"] > best_t["x"] and len(vals) == 1:
                    cur_h = vals[0]
    if cur_barrel is None:
        warnings.append("ROW_VALUES_MISSING(current)")

    # 输出行（%）
    ctl5 = _rightmost5(_row_values(toks, control_y, 0), "control", warnings)

    k = 0.0

    # 低温保持（holding）：标签下方/右侧的 °C 设定值
    holding = None
    hlab = find_label(anchors["holding"], xmax=0.6)
    if hlab:
        lo, hi = rules["holding_range_C"]
        cand = [t for t in toks
                if hlab["y"] - 0.01 < t["y"] < hlab["y"] + 0.08
                and hlab["x"] - 0.15 < t["x"] < hlab["x"] + 0.25]
        vals = [(t["y"], _clean_num(t["text"])) for t in cand]
        vals = [v for v in vals if v[1] is not None and lo <= v[1] <= hi]
        if vals:
            holding = sorted(vals)[0][1]
    if holding is None:
        warnings.append("HOLDING_NOT_FOUND")

    def gate(vals, range_key, row_name):
        if vals is None:
            return None
        lo, hi = rules[range_key]
        out = []
        for i, v in enumerate(vals):
            if lo <= v <= hi:
                out.append(v)
            else:
                out.append(None)
                warnings.append(f"VALUE_OUT_OF_RANGE({row_name}[{i}],{v})")
        return out

    cur_g = gate(cur_barrel, "temperature_range_C", "current") if cur_barrel else None
    cur_h_g = gate([cur_h], "drop_port_range_C", "current_h")[0] if cur_h is not None else None
    set_g = gate(rows["set"], "temperature_range_C", "set")
    high_g = gate(rows["high"], "deviation_range_C", "high")
    low_g = gate(rows["low"], "deviation_range_C", "low")
    ctl_g = gate(ctl5, "control_range_pct", "control")

    def col(vals, i):
        return vals[i] if vals else None

    fields = {
        "barrel_temperature_current_c": cur_g,
        "barrel_temperature_set_c": set_g[:4] if set_g else None,
        "high_deviation_c": high_g[:4] if high_g else None,
        "low_deviation_c": low_g[:4] if low_g else None,
        "control_percent": ctl_g[:4] if ctl_g else None,
        "holding_temperature_c": holding,
        "drop_port_temperature_current_c": cur_h_g,
        "drop_port_temperature_set_c": col(set_g, 4) if set_g else None,
        "drop_port_control_percent": col(ctl_g, 4) if ctl_g else None,
    }
    detail = {
        "row_y": {r: round(lab[r]["y"], 4) for r in lab if lab[r]},
        "deskew_slope": round(k, 4),
        "rows5": {"current": (cur_barrel or []) + ([cur_h] if cur_h is not None else []),
                  "control": ctl5,
                  "high": rows["high"], "set": rows["set"], "low": rows["low"]},
    }
    return {"fields": fields, "heater_columns": 4, "warnings": warnings, "detail": detail}
