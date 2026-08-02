"""FANUC 工序监视页（成型监控）监视设定区提取（049 阶段B B2 Z036 新增）。

取值规则（templates/fanuc.molding_monitor.json）：监视幅+/基准值/监视幅- 三行各 8 列。
行标签不可靠（'监视幅±' 丢符号）、行聚类不可靠（屏幕斜拍使相邻行 y 交叠串行）——
改列锚定：x 聚类出 8 列中心（列间距 ~0.08，周期报警列 x>0.72 排除），每列内按 y 分组
取 ON/OFF 监视行之前的末 3 个值=监视幅+/基准值/监视幅-。'.'->'-' 误识先还原。
周期报警右端三连（上限+/下限/延迟秒）。模次表/统计行为实时数据不取。
返回结构同 extract_families.tact_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM = re.compile(r"\d+\.?\d*")


def _split_nums(text: str) -> list[float]:
    """'0-153'->0.153、'3-00'->3.00（OCR 点成横）。"""
    t = re.sub(r"(\d)-(\d)", r"\1.\2", text.strip())
    return [float(m) for m in NUM.findall(t)]


def extract_molding_monitor_fanuc(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    fields: dict = {}
    detail: dict = {}
    lo_r, hi_r = template["rows"]["monitor_baseline"]["range"]

    # 数值池（设定区 y 窗）
    nums = [(t["y"], t["x"], v) for t in toks
            if 0.42 < t["y"] < 0.68 and 0.08 < t["x"] < 0.85
            for v in _split_nums(t["text"]) if lo_r <= v <= hi_r]

    # x 聚类出列中心（≥3 值的簇，取左起 8 列；周期报警列在后排除）
    xs = sorted(x for _, x, _ in nums)
    cols = []
    for x in xs:
        if cols and x - cols[-1][-1] <= 0.03:
            cols[-1].append(x)
        else:
            cols.append([x])
    centers = [sum(c) / len(c) for c in cols if len(c) >= 3][:8]
    detail["col_centers"] = [round(c, 3) for c in centers]

    # ON/OFF 监视行 y（该行文本无数字）；监视行缺失 -> 设定三行不可得（防模次表值误填充）
    onoff = [t["y"] for t in toks
             if 0.3 < t["y"] < 0.9 and t["text"] in ("OH", "OFF", "ON")]
    names = ["monitor_upper", "monitor_baseline", "monitor_lower"]
    rows: list[list] = [[], [], []]
    if not onoff:
        warnings.append("MONITOR_TOGGLE_ROW_MISSING")
        for name in names:
            fields[name] = None
    else:
        y_end = min(onoff) - 0.005
        if len(centers) < 8:
            warnings.append(f"COL_COUNT_LOW({len(centers)}/8)")
        for c in centers:
            col = sorted((y, v) for y, x, v in nums if abs(x - c) <= 0.035 and y < y_end)
            groups = []
            for y, v in col:
                if groups and y - groups[-1][-1][0] <= 0.025:
                    groups[-1].append((y, v))
                else:
                    groups.append([(y, v)])
            # 设定三行必须紧贴 ON/OFF 行（dy<0.08），否则视为缺失而非模次表值
            last3 = groups[-3:]
            if not last3 or y_end - last3[-1][-1][0] > 0.08:
                last3 = []
            for i in range(3):
                rows[i].append(last3[i][-1][1] if i < len(last3) else None)

        hint = template["rows"].get("first_col_hint", {})
        hv, ht = hint.get("monitor_upper"), hint.get("tolerance", 0.05)
        if hv is not None and (not rows[0] or rows[0][0] is None or abs(rows[0][0] - hv) > ht):
            warnings.append(f"ROW_ANCHOR_MISMATCH(monitor_upper[0],{rows[0][0] if rows[0] else None})")
            rows = [[], [], []]
        complete = all(len(v) == 8 and all(x is not None for x in v) for v in rows)
        for name, vals in zip(names, rows):
            if not complete:
                warnings.append(f"ROW_INCOMPLETE({name},{sum(x is not None for x in vals)}/8)")
                fields[name] = None
            else:
                fields[name] = vals

    # 周期报警：第 9 个 x 簇（设定 8 列之右，x>0.72），取基准行下方 y 序前 3 值
    # （上限/下限/延迟；统计行周期时间列在其上方排除；'+'/秒 后缀常丢不依赖）
    ca = template["cycle_alarm"]
    lo, hi = ca["range"]
    upper = lower = delay = None
    allowed = set(ca.get("upper_values", []))
    up_toks = [t for t in toks
               if any(abs(v - a) <= 0.01 for a in allowed for v in _split_nums(t["text"]))]
    if up_toks and onoff and any(v is not None for v in rows[1]):
        ac = up_toks[0]["x"]
        base_ys = []
        for c in centers:
            col = sorted((y, v) for y, x, v in nums if abs(x - c) <= 0.035 and y < y_end)
            groups = []
            for y, v in col:
                if groups and y - groups[-1][-1][0] <= 0.025:
                    groups[-1].append((y, v))
                else:
                    groups.append([(y, v)])
            if len(groups) >= 2:
                base_ys.append(groups[-2][-1][0])
        y_lo = (sorted(base_ys)[len(base_ys) // 2] - 0.06) if base_ys else 0.45
        pool = [(t["y"], t["x"], v) for t in toks
                if abs(t["x"] - ac) <= 0.045 and t["y"] > y_lo
                for v in _split_nums(t["text"]) if lo <= v <= hi]
        pool.sort()
        got = [v for _, _, v in pool[:3]]
        if len(got) >= 3 and any(abs(got[0] - a) <= 0.01 for a in allowed):
            upper, lower, delay = got[0], got[1], got[2]
    for key, val in zip(ca["keys"], [upper, lower, delay]):
        fields[key] = val
        if val is None:
            warnings.append(f"VALUE_MISSING({key})")

    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
