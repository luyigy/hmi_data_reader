"""FANUC 波形页显示设定提取（049 阶段B B3 Z036 新增）。

取值规则（templates/fanuc.waveform.json）：以通道表头（设定压/射出压/螺杆速度/
螺杆位置）锚定 y_h，其下第 1/第 2 个数值行=最大/最小行（各图斜拍方向不一，
标签+行带不可靠）；每行内按 x 升序取前 4 值=设定压/射出压/螺杆速度/螺杆位置。
X 轴范围=(y_h-0.125, y_h-0.06)×x∈(0.6,0.82) 最右数值（'4秒' 追踪框与最新数据
侧栏在区外；轴端盒值漏检则拒识进 review）。返回结构同 tact_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM = re.compile(r"-?\d+\.?\d*")


def _nums(text: str) -> list[float]:
    t = re.sub(r"(\d)-(\d)", r"\1.\2", text.strip())  # '20-0'->20.0、'0-22'->0.22
    return [float(m) for m in NUM.findall(t)]


def extract_waveform_fanuc(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    fields: dict = {}
    detail: dict = {}

    # 通道表头锚定列（列 x 逐图漂移 ±0.04，行聚类在斜拍交叠下必串行——改列锚定）：
    # 每列取表头下方 y 序前两个值 = 最大/最小行（现在值行在第 3 位自然排除）
    CHANNELS = [("设定压", ["y_axis_max_set_pressure_mpa", None]),
                ("射出压", ["y_axis_max_inject_pressure_mpa", None]),
                ("螺杆速度", ["y_axis_max_screw_velocity_mms", "y_axis_min_screw_velocity_mms"]),
                ("螺杆位置", ["y_axis_max_screw_position_mm", None])]
    hd_all = [t for t in toks if t["text"] in ("设定压", "射出压", "螺杆速度", "螺杆位置")]
    if not hd_all:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["HEADER_NOT_FOUND"], "detail": {}}
    y_h = max(t["y"] for t in hd_all)

    for label, fnames in CHANNELS:
        hd = [t for t in hd_all if t["text"] == label]
        if not hd:
            warnings.append(f"HEADER_MISSING({label})")
            continue
        col_x = max(hd, key=lambda t: t["y"])["x"]
        col_vals = []
        for t in sorted(toks, key=lambda t: t["y"]):
            if t["y"] > y_h + 0.001 and abs(t["x"] - col_x) <= 0.05:
                col_vals.extend(_nums(t["text"]))
        for i, fname in enumerate(fnames):
            if fname is None:
                continue
            fields[fname] = col_vals[i] if i < len(col_vals) else None
            if fields[fname] is None:
                warnings.append(f"VALUE_MISSING({fname})")
        detail[label] = col_vals[:3]

    # X 轴范围：表头上方位带 × x∈(0.6,0.82) 最右值（'4秒' 追踪框按 '秒' 尾排除；
    # rank03 端盒上飘至 -0.15、rank06 仅 CLAHE 变体召回 '0.3'）
    xa = template["x_axis"]
    lo, hi = xa["range"]
    vals = [(t["x"], v) for t in toks
            if y_h - 0.16 < t["y"] < y_h - 0.05 and 0.6 < t["x"] < 0.82
            and "秒" not in t["text"]
            for v in _nums(t["text"]) if lo <= v <= hi]
    x_max = sorted(vals)[-1][1] if vals else None
    if x_max is None:
        warnings.append("VALUE_MISSING(x_axis_max)")
    fields["x_axis_max"] = x_max

    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
