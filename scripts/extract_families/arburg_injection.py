"""ARBURG（阿博格 SELOGICA）注射页提取（049 阶段A A7 Z068 新增）。

取值规则（templates/arburg.injection_metering.json）：段表 v/p/s 三行以行尾单位
token（'mm/s'/'bar'/'mm'，y>0.6 排除图表轴标签）锚行，行内数值按 x 排序取最右
3 个=段3/段2/段1（左侧当前值/绿字实际列排除），倒置为段1→段3。进料位=顶部
蓝框 Xmm 粘连 token；转压位=段3 s（最左设定列）。返回结构同 tact_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM = re.compile(r"\d+\.?\d*")

# OCR 单位误识候选（rank01 'mm'->'mrmi'、rank06 'mm/s'->'mmfs' 实测）
UNIT_VARIANTS = {
    "mm": ["mm", "mrmi", "mrm"],
    "mm/s": ["mm/s", "mmfs", "mmis", "mmls"],
    "bar": ["bar"],
}


def _first_num(text: str) -> float | None:
    m = NUM.search(text)
    return float(m.group()) if m else None


def extract_injection_arburg(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    rows = template["rows"]
    singles = template["singles"]
    detail: dict = {}
    out_rows: dict[str, list[float] | None] = {}

    for name, spec in rows.items():
        lo, hi = spec["range"]
        units = [t for t in toks
                 if t["text"] in UNIT_VARIANTS.get(spec["unit"], [spec["unit"]])
                 and t["y"] >= spec["unit_y_min"]]
        if not units:
            warnings.append(f"UNIT_ROW_NOT_FOUND({name})")
            out_rows[name] = None
            continue

        def row_vals(unit):
            vals = []
            for t in sorted(toks, key=lambda t: t["x"]):
                if abs(t["y"] - unit["y"]) <= spec["dy"] and t["x"] < unit["x"] - 0.01:
                    v = _first_num(t["text"])
                    if v is None or not (lo <= v <= hi):
                        continue
                    if spec.get("decimal") and "." not in t["text"]:
                        continue  # 位置行须 X.XX 形态（'349' 绿字实际值等裸整数噪声排除）
                    vals.append(v)
            return vals

        # 图表轴单位（'mm'@y0.63 等）与行尾单位同名：按行内有效值数择优
        vals, unit = max(((row_vals(u), u) for u in units), key=lambda e: len(e[0]))
        got = vals[-spec["take_last"]:]
        if len(got) < spec["take_last"]:
            warnings.append(f"ROW_INCOMPLETE({name},{len(got)}/{spec['take_last']})")
            out_rows[name] = None
        else:
            out_rows[name] = list(reversed(got))  # 屏上段3..段1 -> 段1..段3

    # 进料位（'进料位' 标签右侧蓝框值；顶部仪表小数与周期秒在标签上方/远处不取）
    mp = singles["metering_position_mm"]
    metering = None
    lo, hi = mp["range"]
    for lab in [t for t in toks if _anchor_match(["进料位", "过料位", "进科位"], t["text"])]:
        for t in sorted(toks, key=lambda t: t["x"]):
            if (abs(t["y"] - lab["y"]) <= 0.025 and lab["x"] < t["x"] < lab["x"] + 0.40
                    and "." in t["text"]):
                v = _first_num(t["text"])
                if v is not None and lo <= v <= hi:
                    metering = v
                    break
        if metering is not None:
            break
    if metering is None:
        warnings.append("VALUE_MISSING(metering_position_mm)")

    # 延迟时间
    dl = singles["injection_delay_s"]
    delay = None
    lo, hi = dl["range"]
    for lab in [t for t in toks if _anchor_match(dl["label"], t["text"])]:
        for t in sorted(toks, key=lambda t: t["x"]):
            if abs(t["y"] - lab["y"]) <= 0.03 and lab["x"] < t["x"] < lab["x"] + dl["dx"]:
                v = _first_num(t["text"])
                if v is not None and lo <= v <= hi:
                    delay = v
                    break
        if delay is not None:
            break
    if delay is None:
        # 旁车兜底（s51 ocr_delay.json，_src=delay_box）
        for t in sorted(toks, key=lambda t: t["x"]):
            if t.get("src") == "delay_box" or t.get("_src") == "delay_box":
                v = _first_num(t["text"])
                if v is not None and lo <= v <= hi:
                    delay = v
                    break
    if delay is None:
        warnings.append("VALUE_MISSING(injection_delay_s)")

    pos = out_rows["injection_position_mm"]
    fields = {
        "injection_velocity_mms": out_rows["injection_velocity_mms"],
        "injection_pressure_bar": out_rows["injection_pressure_bar"],
        "injection_position_mm": pos,
        "injection_stages": 3 if pos else None,
        "metering_position_mm": metering,
        "injection_delay_s": delay,
        "vp_switch_mode": template["switch_mode_constant"],
        "vp_switch_position_mm": pos[-1] if pos else None,  # 段3（末段）s=转压位
    }
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
