"""KEBA（伯乐 KePlast 灰 UI）射出页提取（049 阶段A A2 Z031 新增）。

取值规则（templates/keba.injection_metering.json）：段列头（射出 六段~一段 /
保压 五段~一段，从右往左为一段起）实测 x 归列，缺列按等距线性拟合补；
行标签（射出区 压力/速度/终止位置 x<0.15，保压区 压力/速度/时间）锚行 y，
行带非对称（标签在值下方，lo>hi）。蓝色「时间」行（实际值）、顶部实时行、
页底说明一律不取。段数无显式字段：按一段起非零压力列数推断，置
STAGES_INFERRED 告警（status review，防错值入 ok）。

OCR 坑：一段列头常丢首字成裸 '段'（按最右缺失列补）；'压力'→'玉力' 误识
（标签候选列表）；值带单位粘连（'100.0 bar'、'1.000s'、'2.000|s'）；
'9.09%' 类粘连按 X.X + 数字% 切首段；行值跨行带风险用单位后缀互斥护栏
（bar 行拒 '%'/s 尾、% 行拒 s 尾、s 行拒 '%'）。
返回结构同 extract_families.zizes_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM = re.compile(r"\d+\.?\d*")
MERGED_PCT = re.compile(r"^(\d+\.\d)\d+%?$")
SECONDS_LIKE = re.compile(r"\d+\.\d{2,}")  # 3 位小数 = 秒值（bar/pct 行互斥）
LABEL_CANDIDATES = {"压力": ("压力", "玉力", "压为")}
UNIT_GUARDS = {  # (拒含子串, 拒结尾)
    "bar": (("%",), ("s",)),
    "pct": ((), ("s",)),
    "s": (("%", "bar"), ()),
    "mm": (("%",), ("s",)),
}


def _num(text: str) -> float | None:
    """数值解析：先去单位粘连；'9.09%'（=9.0 + 9% 粘连）取首段 X.X。"""
    t = text.strip()
    m = MERGED_PCT.match(t)
    if m:
        return float(m.group(1))
    m = NUM.search(t)
    return float(m.group()) if m else None


def _unit_ok(text: str, unit: str) -> bool:
    if unit == "pct" and MERGED_PCT.match(text.strip()):
        return True  # '9.09%'=9.0+9% 粘连，先于秒值护栏豁免
    bad_sub, bad_tail = UNIT_GUARDS[unit]
    if any(b in text for b in bad_sub):
        return False
    if any(text.rstrip().endswith(b) for b in bad_tail):
        return False
    if unit in ("bar", "pct") and SECONDS_LIKE.search(text):
        return False  # '2.000'/'0.00' 类秒值不进 bar/pct 行
    return True


def _stage_columns(toks, y_lo, y_hi, stages):
    """段列头实测 x：精确命中优先，裸 '段' 补给从右往左第一个缺失段；
    仍缺的列按已知列等距线性拟合（rank02 一二段列头整列漏检实测）。"""
    hits = [t for t in toks if y_lo < t["y"] < y_hi and t["text"].endswith("段")
            and len(t["text"]) <= 2]
    cols = {}
    for t in hits:
        if t["text"] in stages:
            cols[stages.index(t["text"])] = t["x"]
    bare = [t for t in hits if t["text"] == "段"]
    missing = [i for i in range(len(stages)) if i not in cols]
    for t in sorted(bare, key=lambda t: -t["x"]):
        if missing:
            cols[missing.pop(0)] = t["x"]
    if len(cols) >= 2 and len(cols) < len(stages):
        xs = sorted(cols.items())
        (i0, x0), (i1, x1) = xs[0], xs[-1]
        step = (x1 - x0) / (i1 - i0)
        for i in range(len(stages)):
            cols.setdefault(i, x0 + step * (i - i0))
    return [cols.get(i) for i in range(len(stages))]


def _row_values(toks, row_y, centers, band_lo, band_hi, tol, rng, unit):
    """行带（标签下方偏移，lo>hi）内值 token 归列，带单位互斥护栏。

    返回 (values, used_ids)：used_ids 为被取走 token 的 id 集，供逐行消耗。"""
    out = [None] * len(centers)
    used: set[int] = set()
    lo, hi = rng
    for t in toks:
        if not (row_y - band_lo < t["y"] < row_y + band_hi) or t["x"] < 0.3:
            continue
        if not _unit_ok(t["text"], unit):
            continue
        v = _num(t["text"])
        if v is None or not (lo <= v <= hi):
            continue
        d = [abs(t["x"] - c) if c is not None else 9 for c in centers]
        i = min(range(len(centers)), key=lambda k: d[k])
        if d[i] <= tol and out[i] is None:
            out[i] = v
            used.add(id(t))
    return out, used


def _find_row_y(toks, label, x_lo, x_hi, y_lo, y_hi):
    cands = LABEL_CANDIDATES.get(label, (label,))
    for t in sorted(toks, key=lambda t: t["y"]):
        if x_lo <= t["x"] < x_hi and y_lo < t["y"] < y_hi and t["text"] in cands:
            return t["y"]
    return None


def _active_stages(rows):
    """从一段起非零压力列数（段数无显式字段，按页面语义推断）。

    返回 (n, clean)：clean=True 当且仅当截断边界无歧义——前 n 列三行齐全
    且压力/速度均非零，其后各列压力与速度全为 0.0 或缺失（KEBA 面板未启用
    段恒为 0.0）。clean 时不告警（段数视同实测）；否则 STAGES_INFERRED
    告警置 review（防错值入 ok）。
    """
    bars, pcts = rows["bar"], rows["pct"]
    n = 0
    for v in bars:
        if v is None or v == 0.0:
            break
        n += 1
    clean = n > 0
    for i, (b, p) in enumerate(zip(bars, pcts)):
        if i < n:
            if b in (None, 0.0) or p in (None, 0.0):
                clean = False
        else:
            if b not in (None, 0.0) or p not in (None, 0.0):
                clean = False
    return n, clean


def extract_injection_keba(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    vr = template["value_ranges"]
    detail: dict = {}

    def scan_table(spec, tag):
        centers = _stage_columns(toks, *spec["header_y"], spec["stages"])
        detail[f"{tag}_columns"] = centers
        band_lo, band_hi = spec.get("band_asym", (0.032, 0.015))
        rows = {}
        consumed: set[int] = set()
        pool = list(toks)
        # 自上而下逐行取值并消耗 token：标签/值 y 对齐跨图不一致（±0.03），
        # 宽行带必然吞上一行的值，逐行消耗 + 单位互斥护栏替代全局行带
        for label, unit in spec["row_labels"].items():
            x_lo, x_hi = (0.0, spec["row_label_x_max"]) if tag == "injection" \
                else (spec["row_label_x"][0], spec["row_label_x"][1])
            y = _find_row_y(toks, label, x_lo, x_hi, *spec["row_y"])
            if y is None:
                warnings.append(f"ROW_LABEL_MISSING({tag},{label})")
                rows[unit] = [None] * len(centers)
                continue
            vals, used = _row_values(pool, y, centers, band_lo, band_hi,
                                     spec["col_tol"], vr[unit], unit)
            consumed |= used
            pool = [t for t in pool if id(t) not in consumed]
            rows[unit] = vals
        n, clean = _active_stages(rows)
        if not clean:
            warnings.append(f"STAGES_INFERRED({tag},{n})")
        for i in range(n):
            for unit in spec["row_labels"].values():
                if rows[unit][i] is None:
                    warnings.append(f"ROW_INCOMPLETE({tag}[{i}],{unit})")
        return rows, n

    inj_rows, n_inj = scan_table(template["injection"], "injection")
    hold_rows, n_hold = scan_table(template["holding"], "holding")

    def single(name):
        spec = template["singles"][name]
        lo, hi = spec["range"]
        hits = [t for t in toks if _anchor_match(spec["label"], t["text"])]
        for lab in sorted(hits, key=lambda t: t["y"]):
            # 值在行右端（'射出时间'/'保压位置' 实测值 x≈0.90），窗口放宽到行尾；
            # 优先带 's' 单位的 token（蓝色实际行无单位秒值会落入行带，实测）
            cands = sorted([t for t in toks
                            if abs(t["y"] - lab["y"]) <= 0.026
                            and lab["x"] + 0.03 < t["x"] < 0.99],
                           key=lambda t: t["x"])
            cands.sort(key=lambda t: 0 if "s" in t["text"] else 1)
            for t in cands:
                v = _num(t["text"])
                if v is not None and lo <= v <= hi:
                    return v
        warnings.append(f"VALUE_MISSING({name})")
        return None

    inj_time = single("injection_time_s")
    vp_pos = single("vp_switch_position_mm")

    def arr(name, xs, n):
        if not n or len(xs) < n or any(v is None for v in xs[:n]):
            warnings.append(f"ARRAY_INCOMPLETE({name})")
            return None
        return xs[:n]

    fields = {
        "injection_pressure_bar": arr("injection_pressure_bar", inj_rows["bar"], n_inj),
        "injection_velocity_pct": arr("injection_velocity_pct", inj_rows["pct"], n_inj),
        "injection_position_mm": arr("injection_position_mm", inj_rows["mm"], n_inj),
        "injection_stages": n_inj or None,
        "injection_time_s": inj_time,
        "vp_switch_position_mm": vp_pos,
        "holding_pressure_bar": arr("holding_pressure_bar", hold_rows["bar"], n_hold),
        "holding_velocity_pct": arr("holding_velocity_pct", hold_rows["pct"], n_hold),
        "holding_time_s": arr("holding_time_s", hold_rows["s"], n_hold),
        "holding_stages": n_hold or None,
    }
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
