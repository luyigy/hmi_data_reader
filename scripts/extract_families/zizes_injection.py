"""ZIZES（佳明 ZizES 灰绿 UI）射出页提取（049 阶段A A1 Z017 新增）。

取值规则（templates/zizes.injection_metering.json）：行标签（射出一~六/保压一~五，
x<0.12）锚行 y，值 token 按表头 bar/%/mm 实测 x 中心归列（取设定列，红字实际
s 列不取）。右侧单值：射出时间/延时/段数、保压切换（值常与图例粘连 '20=位置1=时间'
取首位数字）、保压段数；底部上限/下限（'160.0下限' 粘连切分）。红字实时值
（页头时间/螺杆位置/射出速度/射出压力/射出终点）一律不取。
返回结构同 extract_families.tact_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM = re.compile(r"\d+\.?\d*")


def _first_num(text: str) -> float | None:
    m = NUM.search(text)
    return float(m.group()) if m else None


def _row_labels(toks, prefix, x_max, y_lo, y_hi):
    hits = [t for t in toks
            if t["x"] < x_max and y_lo < t["y"] < y_hi
            and t["text"].startswith(prefix) and "=" not in t["text"]]
    # OCR 丢首字兜底：'射出三'->'出三'、'保压二'->'压二'
    fallback = re.compile(r"^[出压][一二三四五六]$")
    hits += [t for t in toks
             if t["x"] < x_max and y_lo < t["y"] < y_hi
             and fallback.match(t["text"]) and not t["text"].startswith(prefix)]
    # 去掉「射出时间/保压切换」等右侧标签（x 已过滤，双保险：长度>3 的排除段行）
    hits = [t for t in hits if len(t["text"]) <= 3 or t["text"][:3] in
            ("射出一", "射出二", "射出三", "射出四", "射出五", "射出六",
             "保压一", "保压二", "保压三", "保压四", "保压五")]
    return sorted(hits, key=lambda t: t["y"])


def _col_values(toks, row_y, centers, band, tol, rng):
    """行带内数值 token 归列：每列取离列中心最近且在 tol 内的一个值。"""
    out = [None] * len(centers)
    lo, hi = rng
    for t in toks:
        if abs(t["y"] - row_y) > band or not (0.12 < t["x"] < 0.58):
            continue
        v = _first_num(t["text"])
        if v is None or not (lo <= v <= hi):
            continue
        d = [abs(t["x"] - c) for c in centers]
        i = min(range(len(centers)), key=lambda k: d[k])
        if d[i] <= tol and out[i] is None:
            out[i] = v
    return out


def extract_injection_zizes(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    cols = template["columns"]
    rl = template["row_labels"]
    vr = template["value_ranges"]
    band, tol = cols["assign_tol"] and cols["row_band"], cols["assign_tol"]
    detail: dict = {}

    # 表头实测列中心（缺省用模板值）
    def header_x(keys, y_lo, y_hi, default):
        for t in toks:
            if y_lo < t["y"] < y_hi and t["text"] in keys:
                return t["x"]
        return default

    ic = cols["injection"]
    inj_centers = [header_x({"bar"}, 0.10, 0.18, ic["bar"]),
                   header_x({"%"}, 0.10, 0.18, ic["pct"]),
                   header_x({"mm"}, 0.10, 0.18, ic["mm"])]
    hc = cols["holding"]
    hold_centers = [header_x({"bar"}, 0.55, 0.62, hc["bar"]),
                    header_x({"%"}, 0.55, 0.62, hc["pct"]),
                    None]  # 保压 s 设定列中心由首个保压行实测补（表头两个 'S' 难区分）

    # 右侧单值
    def single(name):
        spec = template["singles"][name]
        hits = [t for t in toks if _anchor_match(spec["label"], t["text"])]
        lo, hi = spec["range"]
        for lab in sorted(hits, key=lambda t: t["y"]):
            for t in sorted(toks, key=lambda t: t["x"]):
                if not (abs(t["y"] - lab["y"]) <= 0.02 and lab["x"] < t["x"] < lab["x"] + 0.30):
                    continue
                if name == "holding_switch_mode" and "=" in t["text"]:
                    v = _first_num(t["text"][0])  # '20=位置1=时间' -> 2
                else:
                    v = _first_num(t["text"])
                if v is not None and lo <= v <= hi:
                    return v
        warnings.append(f"VALUE_MISSING({name})")
        return None

    inj_time = single("injection_time_s")
    inj_delay = single("injection_delay_s")
    inj_stages = single("injection_stages")
    hold_switch = single("holding_switch_mode")
    hold_stages = single("holding_stages")

    def scan_table(rows, n_known, centers, col_ranges, tag):
        """扫段表：返回 (arrays, n_used)。n_known=0 时按尾部空行裁剪推断段数并告警
        （推断态置 review 防错值入 ok）；已知段数内缺列也告警。"""
        arrs = [[] for _ in centers]
        for lab in rows:
            vals = _col_values(toks, lab["y"], centers, band, tol, col_ranges[0])
            vals = [v if v is not None and r[0] <= v <= r[1] else None
                    for v, r in zip(vals, col_ranges)]
            for j, v in enumerate(vals):
                arrs[j].append(v)
        n = n_known or len(rows)
        if not n_known:
            while n and all(arrs[j][n - 1] is None for j in range(len(centers))):
                n -= 1
            warnings.append(f"STAGES_INFERRED({tag},{n})")
        for i in range(min(n, len(rows))):
            if any(arrs[j][i] is None for j in range(len(centers))):
                warnings.append(f"ROW_INCOMPLETE({tag}[{i}])")
        return [a[:n] for a in arrs], n

    # 射出 6 段表
    inj_rows = _row_labels(toks, rl["injection"]["prefix"], rl["injection"]["x_max"],
                           *rl["injection"]["y_range"])[:rl["injection"]["max_rows"]]
    (bars, pcts, mms), n_inj = scan_table(
        inj_rows, int(inj_stages) if inj_stages else 0, inj_centers,
        [vr["bar"], vr["pct"], vr["mm"]], "injection")
    if not inj_stages:
        inj_stages = n_inj
    detail["injection_rows"] = len(inj_rows)

    # 保压 5 段表（第 3 列黑字设定秒；列中心用保压一行实测：bar/% 之后的下一个值）
    hold_rows = _row_labels(toks, rl["holding"]["prefix"], rl["holding"]["x_max"],
                            *rl["holding"]["y_range"])[:rl["holding"]["max_rows"]]
    if hold_centers[2] is None and hold_rows:
        xs = sorted(t["x"] for t in toks
                    if abs(t["y"] - hold_rows[0]["y"]) <= band and 0.12 < t["x"] < 0.58
                    and _first_num(t["text"]) is not None)
        if len(xs) >= 3:
            hold_centers[2] = xs[2]
    if hold_centers[2] is None:
        hold_centers[2] = cols["holding"]["s_set"]
    (hbars, hpcts, htimes), n_hold = scan_table(
        hold_rows, int(hold_stages) if hold_stages else 0, hold_centers,
        [vr["bar"], vr["pct"], vr["s"]], "holding")
    if not hold_stages:
        hold_stages = n_hold
    detail["holding_rows"] = len(hold_rows)

    # 上限/下限
    upper = lower = None
    lo_r, hi_r = template["limits"]["range"]
    up_hits = [t for t in toks if t["text"] == "上限" or t["text"].endswith("上限")]
    if up_hits:
        lab = sorted(up_hits, key=lambda t: t["y"])[-1]
        right = sorted([t for t in toks
                        if abs(t["y"] - lab["y"]) <= 0.03 and t["x"] > lab["x"]],
                       key=lambda t: t["x"])
        for t in right:
            txt = t["text"]
            if "下限" in txt:
                pre = txt.split("下限")[0]
                v = _first_num(pre)
                if v is not None and lo_r <= v <= hi_r:
                    upper = v
                post = txt.split("下限", 1)[1]
                v2 = _first_num(post)
                if v2 is not None and lo_r <= v2 <= hi_r:
                    lower = v2
            elif upper is None:
                v = _first_num(txt)
                if v is not None and lo_r <= v <= hi_r:
                    upper = v
            elif lower is None:
                v = _first_num(txt)
                if v is not None and lo_r <= v <= hi_r:
                    lower = v
    if upper is None:
        warnings.append("VALUE_MISSING(pressure_upper_limit_bar)")
    if lower is None:
        warnings.append("VALUE_MISSING(pressure_lower_limit_bar)")

    def arr(name, xs, n):
        if len(xs) < n or any(v is None for v in xs[:n]):
            warnings.append(f"ARRAY_INCOMPLETE({name})")
            return None
        return xs[:n]

    fields = {
        "injection_pressure_bar": arr("injection_pressure_bar", bars, n_inj) if n_inj else None,
        "injection_velocity_pct": arr("injection_velocity_pct", pcts, n_inj) if n_inj else None,
        "injection_position_mm": arr("injection_position_mm", mms, n_inj) if n_inj else None,
        "injection_stages": inj_stages,
        "injection_time_s": inj_time,
        "injection_delay_s": inj_delay,
        "holding_pressure_bar": arr("holding_pressure_bar", hbars, n_hold) if n_hold else None,
        "holding_velocity_pct": arr("holding_velocity_pct", hpcts, n_hold) if n_hold else None,
        "holding_time_s": arr("holding_time_s", htimes, n_hold) if n_hold else None,
        "holding_stages": hold_stages,
        "holding_switch_mode": hold_switch,
        "pressure_upper_limit_bar": upper,
        "pressure_lower_limit_bar": lower,
    }
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
