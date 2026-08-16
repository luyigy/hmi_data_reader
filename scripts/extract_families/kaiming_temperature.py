"""KAIMING（佳明开明控制器，F1…F6PID 按键 UI）温度页提取（083 PLAN S03 新增）。

布局（templates/kaiming.temperature.json）：9 段炮筒示意图，段号 1-9 排在图形
下方一行；当前值在图形上方逐段一行（仅启用段有值）；设定值行为左标签「设定值」
+ 逐段设定；页底 保温温度 单值。段 1 为射嘴侧（与 ZizES 段序口径一致）。
拍照/OCR 风险：当前值行相邻两段常被并读为一个 6 位 token（'250240'），
列网格不完整时按偶位等长拆分（两段各 2-3 位、双双落回温度值域才拆，留
CELL_SPLIT 告警强制复核）。返回结构同 extract_families.demag。
"""
import re

from .common import _anchor_match  # noqa: F401

_DIGIT_RE = re.compile(r"^[1-9]$")
_NUM_RE = re.compile(r"\d+\.?\d*")


def _num(t):
    m = _NUM_RE.search(t["text"])
    return float(m.group()) if m else None


def extract_temperature_kaiming(toks: list[dict], template: dict) -> dict:
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

    # 段号行：设定行上方 0.01~0.13 内的单位数字 token（1-9），线性拟合 x=a*段+b
    digits: dict[int, dict] = {}
    for t in toks:
        text = t["text"].strip()
        if _DIGIT_RE.fullmatch(text) and set_y - 0.13 < t["y"] < set_y - 0.01:
            idx = int(text)
            if idx not in digits or t["conf"] > digits[idx]["conf"]:
                digits[idx] = t
    if len(digits) < 4:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ZONE_DIGITS_INSUFFICIENT({len(digits)})"],
                "detail": {}}
    idxs = sorted(digits)
    n = len(idxs)
    mx = sum(idxs) / n
    my = sum(digits[i]["x"] for i in idxs) / n
    a = sum((i - mx) * (digits[i]["x"] - my) for i in idxs) / sum((i - mx) ** 2 for i in idxs)
    b = my - a * mx
    if not 0.02 <= a <= 0.15:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ZONE_SPACING_ABNORMAL({a:.4f})"], "detail": {}}
    idx_y = sum(digits[i]["y"] for i in idxs) / n
    col_x = {i: a * i + b for i in range(1, 10)}

    def nearest_col(x, tol):
        j = min(col_x, key=lambda j: abs(col_x[j] - x))
        return j if abs(col_x[j] - x) <= tol else None

    # 设定行：标签右侧同行的数值 token，按 x 吸附段列；段号行的单位数字
    # token（1-9）距设定行可近至 0.02，必须排除（设定温度至少两位）
    set_vals: dict[int, float] = {}
    for t in toks:
        v = _num(t)
        if (v is None or _DIGIT_RE.fullmatch(t["text"].strip())
                or t["x"] < set_lab["x"] + 0.03 or abs(t["y"] - set_y) > 0.025):
            continue
        j = nearest_col(t["x"], 0.5 * a)
        if j is None:
            continue
        if j not in set_vals or t["conf"] > set_vals[j][1]:
            set_vals[j] = (v, t["conf"])
    active = sorted(set_vals)
    if not active or active[0] != 1 or active != list(range(1, len(active) + 1)):
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [
                    f"SET_ROW_NONCONSECUTIVE({','.join(str(j) for j in active)})"],
                "detail": {}}
    zones = active  # 1..N 连续启用段
    n_zones = len(zones)

    # 当前值行：段号行上方（图形顶）逐段数值；相邻两段并读为 4/6 位偶长 token 时
    # 等长拆分（两半均在温度值域、两个目标列均空缺才拆）
    cur_vals: dict[int, tuple[float, dict]] = {}
    band = [t for t in toks if _num(t) is not None
            and not _DIGIT_RE.fullmatch(t["text"].strip())
            and idx_y - 0.18 < t["y"] < idx_y - 0.05
            and t["x"] > col_x[1] - 0.5 * a]
    splits = []
    for t in band:
        text = t["text"].strip()
        pure = re.fullmatch(r"\d+", text)
        if pure and len(text) in (4, 6):
            splits.append(t)
            continue
        j = nearest_col(t["x"], 0.5 * a)
        if j is None or j not in set_vals:
            continue
        if j not in cur_vals or t["conf"] > cur_vals[j][1]["conf"]:
            cur_vals[j] = (_num(t), t)
    for t in splits:
        text = t["text"].strip()
        half = len(text) // 2
        v1, v2 = float(text[:half]), float(text[half:])
        near = sorted((j for j in zones if abs(col_x[j] - t["x"]) <= 0.75 * a),
                      key=lambda j: abs(col_x[j] - t["x"]))
        if len(near) >= 2 and abs(near[0] - near[1]) == 1:
            left, right = min(near[0], near[1]), max(near[0], near[1])
            if (left not in cur_vals and right not in cur_vals
                    and t_lo <= v1 <= t_hi and t_lo <= v2 <= t_hi):
                cur_vals[left] = (v1, t)
                cur_vals[right] = (v2, t)
                warnings.append(f"CELL_SPLIT({text}->{v1:g},{v2:g})")

    setv, cur = [], []
    for j in zones:
        setv.append(set_vals[j][0])
        if j in cur_vals:
            cur.append(cur_vals[j][0])
        else:
            cur.append(None)
            warnings.append(f"CELL_MISSING(current,段{j})")

    # 保温温度：标签右侧/右下同行的最近数值
    holding = None
    hold_l = [t for t in toks if t["x"] < 0.35
              and _anchor_match(anchors["holding"], t["text"])]
    if hold_l:
        h = hold_l[0]
        cands = [t for t in toks if _num(t) is not None
                 and 0.03 < t["x"] - h["x"] < 0.45 and abs(t["y"] - h["y"]) < 0.04]
        if cands:
            holding = _num(min(cands, key=lambda t: (abs(t["y"] - h["y"]), t["x"])))
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
        "zone_columns": {str(j): round(col_x[j], 4) for j in zones},
        "set_row_y": round(set_y, 4),
        "index_row_y": round(idx_y, 4),
        "zone_spacing": round(a, 4),
    }
    return {"fields": fields, "heater_columns": n_zones,
            "warnings": warnings, "detail": detail}
