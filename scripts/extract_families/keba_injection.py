"""KEBA（伯乐蓝 UI）射出页提取（049 阶段A A2 Z031 新增）。

取值规则（templates/keba.injection_metering.json）：段表列=段（一段在最右），
列中心按段头（X段，一段常只剩'段'字）实测；行标签锚行 y（射出行 压力/速度/
终止位置 x<0.12，保压行 压力/速度/时间 0.15<x<0.35）。蓝底「时间」行与顶部
仪表为实际值不取。有效段：射出=压力或速度非零最末段，保压=时间>0 最末段；
数组按段号 1→N（x 降序）。'9.09%' 类粘连按 ^\\d{1,3}\\.\\d 截一位小数。
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
    """百分比列：'9.09%'->9.0（OCR 把 '9.0 %' 粘成 '9.09%'）；
    须含小数点（本页速度值均 X.X 形态）：'9%6'/'96' 类单位误识噪声不取。"""
    if not PCT_STRICT.match(text.strip()):
        return None
    t = text.strip().rstrip("%")
    m = PCT1.match(t)
    if m:
        return float(m.group(1))
    return _first_num(text)


def _seg_centers(toks, y_lo, y_hi, defaults):
    hits = [t for t in toks if y_lo < t["y"] < y_hi and SEG.match(t["text"])]
    if len(hits) < 3:
        return defaults
    centers = sorted((t["x"] for t in hits), reverse=True)  # 一段在最右
    return centers[:len(defaults)]


def _row_y(toks, label, x_lo, x_hi, y_lo, y_hi):
    cands = LABEL_VARIANTS.get(label, [label])
    hits = [t for t in toks
            if x_lo <= t["x"] < x_hi and y_lo < t["y"] < y_hi and t["text"] in cands]
    return hits[0]["y"] if hits else None


# OCR 形近误识候选（rank02 '压力'->'玉力' 实测）
LABEL_VARIANTS = {
    "压力": ["压力", "玉力", "カ"],
}


def _table_value_rows(toks, label_ys, exclude_ys=()):
    """表区值 token 按 y 聚类成值行，与行标签贪心近邻配对（保序）。
    值行-标签偏移逐图漂移（-0.025~+0.007），固定行带会串行；
    表区多出的值行（射出时间单值行/蓝底实际时间行）由贪心跳过。
    exclude_ys：需排除的干扰值行 y（如蓝底实际时间行）。"""
    toks = [t for t in toks if t["x"] > 0.15
            and _first_num(t["text"]) is not None
            and min(label_ys) - 0.05 < t["y"] < max(label_ys) + 0.05]
    for ey in exclude_ys:
        if ey is not None:
            toks = [t for t in toks if abs(t["y"] - ey) > 0.015]
    toks.sort(key=lambda t: t["y"])
    clusters = []
    for t in toks:
        if clusters and t["y"] - clusters[-1][-1]["y"] <= 0.015:
            clusters[-1].append(t)
        else:
            clusters.append([t])
    centers_y = [sum(t["y"] for t in cl) / len(cl) for cl in clusters]
    rows = {}
    # 保序前向扫描：标签按序各取其后首个距离 <0.03 的簇；多余簇（射出时间值行等）跳过
    i = 0
    for lab_y in sorted(label_ys):
        while i < len(centers_y) and abs(centers_y[i] - lab_y) >= 0.03:
            i += 1
        if i < len(centers_y):
            rows[lab_y] = clusters[i]
            i += 1
    return rows


def _cluster_stage_values(cluster, centers, tol, rng, parse):
    out = [None] * len(centers)
    lo, hi = rng
    for t in cluster:
        v = parse(t["text"])
        if v is None or not (lo <= v <= hi):
            continue
        d = [abs(t["x"] - c) for c in centers]
        i = min(range(len(centers)), key=lambda k: d[k])
        if d[i] <= tol and out[i] is None:
            out[i] = v
    return out


def _row_stage_values(toks, row_y, centers, band, tol, rng, parse):
    """行带内数值按列中心归列，返回按段号 1→N 的值列表（None=空）。"""
    out = [None] * len(centers)
    lo, hi = rng
    for t in toks:
        if abs(t["y"] - row_y) > band or t["x"] < 0.15:
            continue
        v = parse(t["text"])
        if v is None or not (lo <= v <= hi):
            continue
        d = [abs(t["x"] - c) for c in centers]
        i = min(range(len(centers)), key=lambda k: d[k])
        if d[i] <= tol and out[i] is None:
            out[i] = v
    return out


def extract_injection_keba(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    tb = template["tables"]
    vr = template["value_ranges"]
    band, tol = tb["row_band"], tb["col_tol"]
    detail: dict = {}

    # ---- 射出 6 段表
    it = tb["injection"]
    inj_centers = _seg_centers(toks, *it["header_y"], it["default_centers"])
    iy = it["header_y"]
    row_y = {}
    for key, lab in it["row_labels"].items():
        row_y[key] = _row_y(toks, lab, 0, it["row_label_x_max"], iy[0], iy[1] + 0.25)
    inj = {}
    inj_labels = [row_y[k] for k in ("pressure", "velocity", "end_position")
                  if row_y.get(k) is not None]
    actual_time_y = None
    if row_y.get("end_position") is not None:
        # 蓝底实际时间行标签（'时间'，x<0.12，在终止位置之下）
        actual_time_y = _row_y(toks, "时间", 0, it["row_label_x_max"],
                               row_y["end_position"] + 0.02, row_y["end_position"] + 0.2)
    vrows = _table_value_rows(toks, inj_labels, exclude_ys=(actual_time_y,)) if len(inj_labels) == 3 else {}
    for key, rng, parse in (("pressure", vr["bar"], _first_num),
                            ("velocity", vr["pct"], _pct_num),
                            ("end_position", vr["mm"], _first_num)):
        if row_y.get(key) is None:
            warnings.append(f"ROW_LABEL_MISSING(injection.{key})")
            inj[key] = None
            continue
        cl = vrows.get(row_y[key])
        if cl is None:
            warnings.append(f"ROW_VALUES_MISSING(injection.{key})")
            inj[key] = None
            continue
        inj[key] = _cluster_stage_values(cl, inj_centers, tol, rng, parse)
    if inj["pressure"] and inj["velocity"]:
        n_inj = 0
        for i in range(len(inj_centers)):
            if (inj["pressure"][i] or 0) > 0 or (inj["velocity"][i] or 0) > 0:
                n_inj = i + 1
    else:
        n_inj = 0
    if n_inj == 0:
        warnings.append("STAGES_NOT_FOUND(injection)")

    # ---- 保压 5 段表
    ht = tb["holding"]
    hold_centers = _seg_centers(toks, *ht["header_y"], ht["default_centers"])
    hy = ht["header_y"]
    hx0, hx1 = ht["row_label_x_range"]
    hrow_y = {}
    for key, lab in ht["row_labels"].items():
        hrow_y[key] = _row_y(toks, lab, hx0, hx1, hy[0], hy[1] + 0.22)
    hold = {}
    hold_labels = [hrow_y[k] for k in ("pressure", "velocity", "time")
                   if hrow_y.get(k) is not None]
    hvrows = _table_value_rows(toks, hold_labels) if len(hold_labels) == 3 else {}
    for key, rng, parse in (("pressure", vr["bar"], _first_num),
                            ("velocity", vr["pct"], _pct_num),
                            ("time", vr["s"], _first_num)):
        if hrow_y.get(key) is None:
            warnings.append(f"ROW_LABEL_MISSING(holding.{key})")
            hold[key] = None
            continue
        cl = hvrows.get(hrow_y[key])
        if cl is None:
            warnings.append(f"ROW_VALUES_MISSING(holding.{key})")
            hold[key] = None
            continue
        hold[key] = _cluster_stage_values(cl, hold_centers, tol, rng, parse)
    if hold["time"]:
        n_hold = 0
        for i in range(len(hold_centers)):
            if (hold["time"][i] or 0) > 0:
                n_hold = i + 1
    else:
        n_hold = 0
    if n_hold == 0:
        warnings.append("STAGES_NOT_FOUND(holding)")

    # ---- 单值
    sp = template["singles"]

    def single_num(name, x_min=0.8):
        s = sp[name]
        lo, hi = s["range"]
        for lab in [t for t in toks if t["text"] == s["label"]]:
            cands = []
            for t in toks:
                # 值恒在标签同高或上方（上方段一列）；下方蓝底实际时间行排除
                if -0.03 <= t["y"] - lab["y"] <= 0.005 and t["x"] > x_min:
                    v = _first_num(t["text"])
                    if v is not None and lo <= v <= hi:
                        cands.append((t["x"], v))
            if cands:
                return sorted(cands)[-1][1]
        warnings.append(f"VALUE_MISSING({name})")
        return None

    inj_time = single_num("injection_time_s", x_min=0.8)
    vp_pos = None
    for lab in [t for t in toks if t["text"] == sp["vp_switch_position_mm"]["label"]]:
        lo, hi = sp["vp_switch_position_mm"]["range"]
        for t in toks:
            if abs(t["y"] - lab["y"]) <= 0.02 and lab["x"] < t["x"] < lab["x"] + 0.3:
                v = _first_num(t["text"])
                if v is not None and lo <= v <= hi:
                    vp_pos = v
                    break
        if vp_pos is not None:
            break
    if vp_pos is None:
        warnings.append("VALUE_MISSING(vp_switch_position_mm)")

    switch_mode = None
    for lab in [t for t in toks if t["text"] == sp["holding_switch_mode"]["label"]]:
        x0, x1 = sp["holding_switch_mode"]["x_range"]
        for t in toks:
            if abs(t["y"] - lab["y"]) <= 0.025 and x0 < t["x"] < x1:
                for v in sp["holding_switch_mode"]["values"]:
                    if v == t["text"] or (v != "时间" and v in t["text"]):
                        switch_mode = v
                        break
            if switch_mode:
                break
        if switch_mode:
            break
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
    detail["seg_centers"] = {"injection": inj_centers, "holding": hold_centers}
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
