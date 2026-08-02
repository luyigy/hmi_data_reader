"""B_AND_R（贝加莱 BKS 白灰 UI）射胶页提取（049 阶段A A3 Z050 新增）。

取值规则（templates/b_and_r.injection_metering.json）：照片倾斜/裁剪差异大，
固定 y 区域不可靠——以灰色节标题锚定：「射胶」表头（曲线区同名标签之下、
保压表头之上的最大 y）、「保压」表头（保压切换之上最大 y）、「保压切换」。
节内数值 token 按 y 聚类（gap 0.025）成行：射胶区取前 3 簇=速度/压力/位置
（第 4 簇为蓝色实际秒行，跳过）；保压区 3 簇=速度/压力/时间。行内值按 x
降序右对齐归段（段 1 恒在最右；各行格子阶梯错位，不用共享列中心）。
段头数字行按 `^\\d$` 排除；段数无显式字段，按段 1 起非零压力列数推断
（无歧义规则同 keba_injection）。顶部曲线/实时行、底部 实际切换* 不取。
返回结构同 extract_families.keba_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM = re.compile(r"\d+\.?\d*")
BARE_DIGIT = re.compile(r"^\d$")  # 段头数字行（'5'..'1'），真值均带小数点


def _num(text: str) -> float | None:
    m = NUM.search(text.strip())
    return float(m.group()) if m else None


def _anchor_y(toks, text, before=None):
    """指定文本锚点的 y；有 before 时取其下方最近（y 最大且 < before）。"""
    cands = [t["y"] for t in toks if t["text"] == text
             and (before is None or t["y"] < before)]
    return max(cands) if cands else None


def _y_clusters(toks, y0, y1, x0=0.25, x1=0.90):
    """区域内数值 token 按 y 聚类成行（gap 0.025），排除段头裸数字。"""
    vals = [t for t in toks if y0 < t["y"] < y1 and x0 <= t["x"] <= x1
            and not BARE_DIGIT.match(t["text"]) and _num(t["text"]) is not None]
    vals.sort(key=lambda t: t["y"])
    clusters: list[list[dict]] = []
    for t in vals:
        if clusters and t["y"] - clusters[-1][-1]["y"] <= 0.025:
            clusters[-1].append(t)
        else:
            clusters.append([t])
    return clusters


def _cluster_values(cluster, rng):
    """簇内值按 x 降序右对齐归段：[段1, 段2, ...]。"""
    lo, hi = rng
    vals = []
    for t in cluster:
        v = _num(t["text"])
        if v is not None and lo <= v <= hi:
            vals.append((t["x"], v))
    vals.sort(key=lambda xv: -xv[0])
    return [v for _, v in vals]


def _active_stages(bars, pcts):
    """段 1 起非零压力列数 + 无歧义检查（截断后全 0/缺；前 n 列压力速度非零）。"""
    n = 0
    for v in bars:
        if v is None or v == 0.0:
            break
        n += 1
    clean = n > 0
    for i in range(max(len(bars), len(pcts))):
        b = bars[i] if i < len(bars) else None
        p = pcts[i] if i < len(pcts) else None
        if i < n:
            if b in (None, 0.0) or p in (None, 0.0):
                clean = False
        else:
            if b not in (None, 0.0) or p not in (None, 0.0):
                clean = False
    return n, clean


def extract_injection_b_and_r(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    vr = template["value_ranges"]
    detail: dict = {}

    y_sw = _anchor_y(toks, "保压切换")
    y_hold = _anchor_y(toks, "保压", before=y_sw) if y_sw is not None else None
    y_inj = _anchor_y(toks, "射胶", before=y_hold) if y_hold is not None else None
    detail["anchors"] = {"injection": y_inj, "holding": y_hold, "switch": y_sw}
    for name, y in (("保压切换", y_sw), ("保压", y_hold), ("射胶", y_inj)):
        if y is None:
            warnings.append(f"ANCHOR_MISSING({name})")

    def scan_table(y0, y1, units, tag):
        """units: 按行序的单位列表，如 ['pct','bar','mm']。"""
        if y0 is None or y1 is None:
            return {u: [] for u in units}, 0
        clusters = _y_clusters(toks, y0 + 0.005, y1 - 0.005)
        if tag == "injection" and len(clusters) == len(units) + 1:
            clusters = clusters[:-1]  # 末簇为蓝色实际秒行，跳过
        detail[f"{tag}_clusters"] = len(clusters)
        if len(clusters) != len(units):
            warnings.append(f"ROW_CLUSTER_COUNT({tag},{len(clusters)})")
        rows = {}
        for i, unit in enumerate(units):
            rows[unit] = _cluster_values(clusters[i], vr[unit]) \
                if i < len(clusters) else []
        n, clean = _active_stages(rows.get("bar", []), rows.get("pct", []))
        if not clean:
            warnings.append(f"STAGES_INFERRED({tag},{n})")
        return rows, n

    inj_rows, n_inj = scan_table(y_inj, y_hold, ["pct", "bar", "mm"], "injection")
    hold_rows, n_hold = scan_table(y_hold, y_sw, ["pct", "bar", "s"], "holding")

    def single(name):
        spec = template["singles"][name]
        lo, hi = spec["range"]
        if y_sw is None:
            warnings.append(f"VALUE_MISSING({name})")
            return None
        lx0, lx1 = spec["label_x"]
        labs = [t for t in toks if t["text"] == spec["label"]
                and lx0 <= t["x"] < lx1
                and y_sw + 0.005 < t["y"] < y_sw + 0.11]
        for lab in sorted(labs, key=lambda t: t["y"]):
            cands = sorted([t for t in toks
                            if abs(t["y"] - lab["y"]) <= 0.02
                            and lab["x"] + 0.03 < t["x"] < lab["x"] + 0.35],
                           key=lambda t: t["x"])
            for t in cands:
                v = _num(t["text"])
                if v is not None and lo <= v <= hi:
                    return v
        warnings.append(f"VALUE_MISSING({name})")
        return None

    vp_pos = single("vp_switch_position_mm")
    sw_time = single("switch_time_s")

    def arr(name, xs, n):
        if not n or len(xs) < n or any(v is None for v in xs[:n]):
            warnings.append(f"ARRAY_INCOMPLETE({name})")
            return None
        return xs[:n]

    fields = {
        "injection_pressure_bar": arr("injection_pressure_bar", inj_rows.get("bar", []), n_inj),
        "injection_velocity_pct": arr("injection_velocity_pct", inj_rows.get("pct", []), n_inj),
        "injection_position_mm": arr("injection_position_mm", inj_rows.get("mm", []), n_inj),
        "injection_stages": n_inj or None,
        "vp_switch_position_mm": vp_pos,
        "switch_time_s": sw_time,
        "holding_pressure_bar": arr("holding_pressure_bar", hold_rows.get("bar", []), n_hold),
        "holding_velocity_pct": arr("holding_velocity_pct", hold_rows.get("pct", []), n_hold),
        "holding_time_s": arr("holding_time_s", hold_rows.get("s", []), n_hold),
        "holding_stages": n_hold or None,
    }
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
