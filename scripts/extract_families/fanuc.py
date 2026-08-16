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
    数值形态：1~3 位整数 + 1 位小数（083 S04 起含 0.0/5.0 等一位整数——M1-M4 的 0.0
    由 x 带 + 取最右 5 列自然排除，而输出/偏差行的 0.x、5.x 本来就是合法值）；整 token
    三位整数（'280'）或带尾点（'285.'/'20.'）按丢小数位兜底，裸 2 位整数不兜底
    （防偏差 50 误当值）。"""
    t = text.strip()
    t = re.sub(r"(\d)-(\d)", r"\1.\2", t)  # OCR 点成横：'90-3'->90.3、'50-0oC'->50.0oC
    t = re.sub(r"(\d)[、·](\d)", r"\1.\2", t)  # OCR 点成顿号/间隔号：'11、5'->11.5
    t = re.sub(r"(\d{2,3})(\d)(?=\d{2,3}\.\d)", r"\1.\2", t)
    vals = [float(m) for m in re.findall(r"\d{1,3}\.\d", t)]
    if not vals and re.fullmatch(r"\d{3}|\d{1,3}\.", t):
        vals = [float(t.rstrip("."))]
    return vals


def _clean_num(text: str) -> float | None:
    """清洗 OCR 数值：'90-3'->90.3、'31.8X'->31.8、'50.0°℃'->50.0。"""
    vals = _split_nums(text)
    return vals[0] if vals else None


def _cell_num(text: str) -> float | None:
    """单格 OCR 只取首个数值，容忍小数点被读成横线和单位残字。"""
    text = re.sub(r"(\d)-(\d)", r"\1.\2", text)
    match = re.search(r"\d{1,3}(?:\.\d)?", text)
    return float(match.group()) if match else None


def _row_values(toks, y, k, x_lo=0.25, x_hi=0.7, tol=0.018):
    """某行 y（按斜率 k 修正）附近的数值 token，按 x 排序；粘连 token 切分后同位展开。"""
    band = [t for t in toks
            if abs(t["y"] - (y + k * (t["x"] - 0.5))) < tol and x_lo < t["x"] < x_hi]
    out = []
    for t in sorted(band, key=lambda t: t["x"]):
        for v in _split_nums(t["text"]):
            out.append((t["x"], v, t))
    return out


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

    base_toks = [t for t in toks if t.get("src") != "fanuc_cell"]

    # 083 S04：实拍倾斜图的行带 deskew。行标签在表区左侧、数值在右侧，整机
    # 照片倾斜时固定 y 行带会在右侧切到相邻行（实测倾斜达 |k|≈0.08，右端错位
    # 0.03+ 超行带容差）。斜率优先取表头字母行（M1..H 单 token 天然共线）；
    # 表头不足时退回「标签 y 处校正距离归行 + 逐行拟合 + 跨行中位」两轮收敛。
    HEADER_ALIAS = {"M1", "M2", "M3", "M4", "N", "H",
                    "B1", "B2", "B3", "BI", "82", "83"}

    def _fit_header_slope() -> float | None:
        cur_y = lab["current"]["y"] if lab["current"] else lab["control"]["y"]
        heads = [t for t in base_toks
                 if t["text"].strip().upper() in HEADER_ALIAS
                 and 0.1 < t["x"] < 0.75 and t["y"] < cur_y - 0.01]
        xs = [t["x"] for t in heads]
        if len(heads) < 3 or max(xs) - min(xs) < 0.2:
            return None
        return _fit_slope(heads)

    def _fit_table_slope(k0: float) -> float:
        slopes = []
        for name in ("high", "set", "low", "control", "current"):
            lab_t = lab[name]
            if not lab_t:
                continue
            band = [t for t in base_toks
                    if abs(t["y"] - (lab_t["y"] + k0 * (t["x"] - lab_t["x"]))) < 0.03
                    and 0.15 < t["x"] < 0.75 and _split_nums(t["text"])]
            xs = [t["x"] for t in band]
            if len(band) >= 4 and max(xs) - min(xs) >= 0.25:
                slopes.append(_fit_slope(band))
        if not slopes:
            return 0.0
        slopes.sort()
        return slopes[len(slopes) // 2]

    k = _fit_header_slope()
    if k is None:
        k = _fit_table_slope(0.0)
        if k:
            k2 = _fit_table_slope(k)
            if abs(k2) <= 0.2:
                k = k2
    if abs(k) > 0.2:  # 异常斜率按无倾斜处理（防误判反而拉歪正常截图）
        k = 0.0

    def _y05(name):
        """行标签 y 换算为 x=0.5 参考处的行 y（_row_values 的参考系）。"""
        lab_t = lab[name]
        return lab_t["y"] + k * (0.5 - lab_t["x"]) if lab_t else None

    # 在线服务生成的 Profile 专用逐格旁车。按斜率校正后的最近行标签归组，
    # 必须 5 列齐全才采用；任一非 NZ 列缺失仍走基础 OCR 并保留缺格告警。
    y05 = {name: _y05(name) for name in lab if lab[name]}
    cell_tokens = {name: [] for name in lab}
    for token in (t for t in toks if t.get("src") == "fanuc_cell"):
        if not y05:
            break
        name = min(y05, key=lambda n: abs(token["y"] - (y05[n] + k * (token["x"] - 0.5))))
        if abs(token["y"] - (y05[name] + k * (token["x"] - 0.5))) < 0.02:
            cell_tokens[name].append(token)
    cell_rows = {}
    for name, row_tokens in cell_tokens.items():
        values = [_cell_num(t["text"]) for t in sorted(row_tokens, key=lambda t: t["x"])]
        cell_rows[name] = values if len(values) == 5 and all(v is not None for v in values) else None

    # 内容锚定行网格：设定行是表区唯一含 ≥3 个 ≥100 数值的行（行值域约束），
    # 找到后按行距（标签实测，缺省用模板均值）向上下展开 上限/下限/输出/现在。
    # 不依赖标签与数值的纵向对齐（倾斜暗图错位可达 0.05）；083 S04 起扫描与
    # 取值均按实测斜率 k 校正（x=0.5 参考系）。
    def find_set_y():
        # 扫描范围限定在上/下限标签之间（排除 现在 行粘连 blob 的同值域干扰）；
        # 按切分后 ≥100 的「值」计数（设定行 mega 粘连 token 也能积满 3）
        y_lo = _y05("high") - 0.01
        y_hi = _y05("low") + 0.01
        best, best_n = None, 0
        y = y_lo
        hits = []
        while y < y_hi:
            band = [t for t in toks
                    if abs(t["y"] - (y + k * (t["x"] - 0.5))) < 0.018
                    and 0.25 < t["x"] < 0.7]
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
        # 密度扫描失败时退回「设定」行标签 y（标签检测到即用，避免整页硬拒；
        # 标签与数值的纵向错位由后续 _row_values 的行带容差吸收，漏检值仍 CELL_MISSING）。
        if cell_rows.get("set"):
            set_y = _y05("set")
        elif lab["set"]:
            set_y = _y05("set")
            warnings.append("SET_ROW_LABEL_FALLBACK")
        else:
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
        vals = _row_values(base_toks, ry, k)
        if len(vals) == 4:
            # 边缘列（多为 H）略出行带：放宽一档补一次
            vals2 = _row_values(base_toks, ry, k, tol=0.028)
            if len(vals2) >= 5:
                vals = vals2
        base_row = [v for _, v, _ in vals[-5:]] if len(vals) >= 5 else None
        # 083 S04 起各行统一基础 OCR 优先、逐格旁车仅在基础行不完整时兜底
        # （旁车单格裁切在倾斜实拍上可能丢首位数字，实测高置信错值 80.0/90.0）。
        rows[r] = base_row or cell_rows.get(r)
        if rows[r] is None:
            warnings.append(f"ROW_VALUES_MISSING({r},{len(vals)}/5)")

    # 现在行：本行多值粘连块可能是 N..B3（4 值）或 N..H（5 值，H 料口也粘进来）。
    # 逐 token 切分并值域过滤，取有效值最多的 token：
    #   - 5 值（N,B1,B2,B3,H 粘连）：前 4 = 料筒，末 1 = 料口 H（042 S02 修复：
    #     旧逻辑取末 4 会丢 N、错把 H 填进 B3 位）
    #   - 4 值（仅 N..B3）：整组为料筒，H 取 blob 右侧独立单值 token
    cur_barrel = cur_h = None
    band = [t for t in base_toks
            if abs(t["y"] - (current_y + k * (t["x"] - 0.5))) < 0.02
            and 0.2 < t["x"] < 0.7]
    cands = []
    for t in sorted(band, key=lambda t: t["x"]):
        vals = [v for v in _split_nums(t["text"]) if 0 <= v <= 400]
        if vals:
            cands.append((t, vals))
    if cands:
        best_t, best_v = max(cands, key=lambda e: (len(e[1]), e[0]["conf"]))
        if len(best_v) >= 5:
            cur_barrel = best_v[:4]
            cur_h = best_v[4]
            if not cell_rows.get("current"):
                warnings.append("CURRENT_ROW_GLUED_SPLIT")
        elif len(best_v) >= 4:
            cur_barrel = best_v[-4:]
            if len(_split_nums(best_t["text"])) > 1:
                if not cell_rows.get("current"):
                    warnings.append("CURRENT_ROW_GLUED_SPLIT")
            for t, vals in cands:
                if t["x"] > best_t["x"] and len(vals) == 1:
                    cur_h = vals[0]
    # 逐格旁车仅在基础粘连 blob 缺失时兜底（同 high/set/low 的基础优先口径）
    if cur_barrel is None and cell_rows.get("current"):
        cur_barrel, cur_h = cell_rows["current"][:4], cell_rows["current"][4]
    if cur_barrel is None:
        warnings.append("ROW_VALUES_MISSING(current)")

    # 输出行（%）：基础 OCR 优先，缺格再由逐格旁车兜底，双缺才告警
    base_ctl = _row_values(base_toks, control_y, k)
    ctl5 = [v for _, v, _ in base_ctl[-5:]] if len(base_ctl) >= 5 else None
    if ctl5 is None:
        ctl5 = cell_rows.get("control")
    if ctl5 is None:
        warnings.append(f"ROW_VALUES_MISSING(control,{len(base_ctl)}/5)")
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
