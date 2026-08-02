"""FANUC（发那科 ROBOSHOT 浅蓝 UI）射出·计量页提取（035 第三波 Z036 新增）。

取值规则（templates/fanuc.injection_metering.json）：标签同行右侧 y±0.02 的数值
token（常两格粘连，如 '185:0220.0'/'200-0210-0'，按 X.X 形态切分）。
保压 P1/P2 与计量 3 段（背压/转速/切换位置）整块行位置随图漂移 ±0.05，固定
row_y_hint 不可靠——改为左列行标签锚定行 y（'2段'/'HR模式'/'背压'/'转速'/'切换位置'，
x<0.25），再扫行带取值；row_y_hint 仅作标签漏检时的兜底。保压行只采小数形态
token（避开段序号裸整数 1/2）。右上单值（背压/转速）用 x_hint 0.74 区分计量区
同名标签；减压值在标签下方窗口取最下行（其上是减压速度行）。射出速度/最大射出压
屏幕列序为 [2段,1段]，组装时逆序。返回结构同 extract_families.tact_injection。
"""
import re

from .common import _anchor_match  # noqa: F401

DEC = re.compile(r"\d{1,3}\.\d")
INT = re.compile(r"\d{1,3}")


def _split_nums(text: str) -> list[float]:
    """切数值：OCR 点误识为横/冒号（'8-5'->8.5、'185:0220.0'->185.0+220.0）；
    无小数形态时回退整数（'100'->100.0；跳过紧贴字母/符号的单位尾巴如 'min-1'->1）。"""
    t = re.sub(r"(\d)[-:](\d)", r"\1.\2", text.strip())
    vals = [float(m) for m in DEC.findall(t)]
    if not vals and re.fullmatch(r"\d{4}", t):
        # 两格 X.X 丢点粘连：'8585'->8.5+8.5（本页数值均 ≤3 位整数）
        return [float(t[0] + "." + t[1]), float(t[2] + "." + t[3])]
    if not vals:
        for m in INT.finditer(t):
            prev = t[m.start() - 1] if m.start() > 0 else ""
            if prev and (prev.isalpha() or prev in "-:"):
                continue
            vals.append(float(m.group()))
    return vals


def _row_nums(toks, y, x_lo=0.1, x_hi=0.65, dy_lo=0.025, dy_hi=0.015, dec_only=False):
    """行带内的数值，按 x 排序展开（粘连 token 同位切分）。
    值恒在标签同高度或上方（FANUC 表区标签靠行底）：下行带收窄到 +0.015，
    防止相邻行值互串（rpm 行吞切换位置粘连块、保压 P1 行吞 P2 秒值）。
    dec_only=True 时只采含小数形态的 token（保压行避开段序号裸整数）。"""
    out = []
    band = [t for t in toks if -dy_lo <= t["y"] - y <= dy_hi and x_lo < t["x"] < x_hi]
    for t in sorted(band, key=lambda t: (t["x"], t["y"])):
        if dec_only and not DEC.search(re.sub(r"(\d)[-:](\d)", r"\1.\2", t["text"])):
            continue
        for v in _split_nums(t["text"]):
            out.append((t["x"], v, t))
    return out


def _take(vals, count, rng, name, warnings):
    lo, hi = rng
    got = [v for _, v, _ in vals if lo <= v <= hi][:count]
    if len(got) < count:
        warnings.append(f"VALUE_MISSING({name},{len(got)}/{count})")
        return None
    return got


# 行字段 -> (行标签, 标签 y 下限)：标签须 x<0.25 且 y>y_min（避开页眉/右上同名标签）
ROW_LABELS = {
    "holding_pressure_p1_mpa": ("2段", 0.3),
    "holding_pressure_p2_mpa": ("HR模式", 0.3),
    "metering_back_pressure_mpa": ("背压", 0.55),
    "metering_rpm_stages": ("转速", 0.55),
    "metering_switch_positions_mm": ("切换位置", 0.55),
}


def _find_row_y(toks, name, hint):
    label, y_min = ROW_LABELS[name]
    hits = [t for t in toks
            if t["x"] < 0.25 and t["y"] > y_min and _anchor_match(label, t["text"])]
    if hits:
        return min(hits, key=lambda t: abs(t["y"] - hint))["y"] if hint else hits[0]["y"]
    if name == "holding_pressure_p1_mpa":
        # '2段'常被拆成 '2'+'段' 两个 token：用 '段'（x<0.15 排除 '3段'）锚定；
        # 再退化为 HR模式行上移一个行距（实测 0.034~0.040），最后才用固定 hint
        seg = [t for t in toks if t["x"] < 0.15 and t["y"] > y_min and t["text"] == "段"]
        if seg:
            return seg[0]["y"]
        hr = [t for t in toks if t["x"] < 0.25 and t["y"] > y_min
              and _anchor_match("HR模式", t["text"])]
        if hr:
            return hr[0]["y"] - 0.037
    return hint


def extract_injection_fanuc(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    anchors = template["field_anchors"]
    win = template.get("value_window", {"dy": 0.02, "dx_max": 0.35})
    detail: dict = {}
    raw: dict[str, list[float] | None] = {}

    def label_hits(spec):
        return [t for t in toks if spec.get("label") and _anchor_match(spec["label"], t["text"])]

    for name, spec in anchors.items():
        count, rng = spec["count"], spec["range"]
        if spec.get("row_y_hint") is not None and spec.get("label") is None:
            continue  # 保压秒列：由压力行带出
        if name == "decompress_mms":
            got = None
            for lab in sorted(label_hits(spec), key=lambda t: t["y"]):
                cands = [(t["y"], v) for t in toks
                         if 0.02 < t["y"] - lab["y"] <= 0.09 and abs(t["x"] - lab["x"]) <= 0.08
                         for v in _split_nums(t["text"]) if rng[0] <= v <= rng[1]]
                if cands:
                    got = [max(cands)[1]]  # 减压距离在减压速度行之下，取最下行
                    break
            raw[name] = got
            if got is None:
                warnings.append(f"VALUE_MISSING({name})")
            continue
        if spec.get("below") is not None:
            # 值在标签下方窗口（计量位置 45.00、减压位置 5.00），取最上一行
            dy_lo, dy_hi = spec["below"]
            got = None
            for lab in sorted(label_hits(spec), key=lambda t: t["y"]):
                cands = [(t["y"] - lab["y"], v) for t in toks
                         if dy_lo <= t["y"] - lab["y"] <= dy_hi
                         and abs(t["x"] - lab["x"]) <= spec.get("dx", 0.04)
                         for v in _split_nums(t["text"]) if rng[0] <= v <= rng[1]]
                if cands:
                    got = [min(cands)[1]]
                    break
            raw[name] = got
            if got is None:
                warnings.append(f"VALUE_MISSING({name})")
            continue
        if name in ROW_LABELS:
            row_y = _find_row_y(toks, name, spec.get("row_y_hint"))
            if row_y is None:
                warnings.append(f"ROW_LABEL_MISSING({name})")
                raw[name] = None
                continue
            dec_only = name.startswith("holding_")
            vals = _row_nums(toks, row_y, dec_only=dec_only)
            if dec_only:
                # 保压行：第 1 值=压力、第 2 值=秒（秒列在循环外带出）
                raw[name] = _take(vals[:1], 1, rng, name, warnings)
            else:
                raw[name] = _take(vals, count, rng, name, warnings)
            if raw[name] is not None:
                detail[name] = [t["text"] for _, _, t in vals]
            continue
        # 标签同行右侧取值（x_hint 区分同名标签）
        got = None
        for lab in sorted(label_hits(spec), key=lambda t: t["y"]):
            cands = []
            for t in toks:
                if not (abs(t["y"] - lab["y"]) <= win["dy"] and lab["x"] < t["x"]):
                    continue
                for v in _split_nums(t["text"]):
                    if rng[0] <= v <= rng[1]:
                        cands.append((t["x"], v, t))
            cands = [c for c in cands if c[0] - lab["x"] <= win["dx_max"]]
            if spec.get("x_hint") is not None:
                # 右上单值块随图左右漂移（值 x 0.73~0.86）：按离标签最近取值，
                # 靠标签 y 序（右上块在上）与 dx_max 排除右侧「最新数据」实时值
                cands.sort(key=lambda c: c[0] - lab["x"])
            else:
                cands.sort()
            if cands:
                got = [v for _, v, _ in cands[:count]]
                detail[name] = [t["text"] for _, _, t in cands[:count]]
                break
        if got is None or len(got) < count:
            warnings.append(f"VALUE_MISSING({name})")
            raw[name] = None
        else:
            raw[name] = got

    # 保压秒列：与压力同行扫描，第 2 个小数值为秒
    for prow, tname in (("holding_pressure_p1_mpa", "holding_time_p1_s"),
                        ("holding_pressure_p2_mpa", "holding_time_p2_s")):
        spec = anchors[prow]
        row_y = _find_row_y(toks, prow, spec.get("row_y_hint"))
        vals = _row_nums(toks, row_y, dec_only=True) if row_y is not None else []
        tspec = anchors[tname]
        raw[tname] = _take(vals[1:], 1, tspec["range"], tname, warnings)

    def one(name):
        v = raw.get(name)
        return v[0] if v else None

    fields = {
        # 屏幕列序 [2段,1段] -> 真值 [V1,V2]（Z036 六图实测一致）
        "injection_velocity_mms": (list(reversed(raw["injection_velocity_mms"]))
                                   if raw.get("injection_velocity_mms") else None),
        "injection_pressure_limit_mpa": (list(reversed(raw["injection_pressure_limit_mpa"]))
                                         if raw.get("injection_pressure_limit_mpa") else None),
        "injection_switch_position_mm": one("injection_switch_position_mm"),
        "vp_switch_position_mm": one("vp_switch_position_mm"),
        "holding_pressure_mpa": ([one("holding_pressure_p1_mpa"), one("holding_pressure_p2_mpa")]
                                 if raw.get("holding_pressure_p1_mpa") and raw.get("holding_pressure_p2_mpa")
                                 else None),
        "holding_stages": 2,
        "holding_time_s": ([one("holding_time_p1_s"), one("holding_time_p2_s")]
                           if raw.get("holding_time_p1_s") and raw.get("holding_time_p2_s")
                           else None),
        "max_injection_time_s": one("max_injection_time_s"),
        "holding_limit_speed_mms": one("holding_limit_speed_mms"),
        "injection_alarm_pressure_mpa": one("injection_alarm_pressure_mpa"),
        "back_pressure_mpa": one("back_pressure_mpa"),
        "metering_rpm": one("metering_rpm"),
        "metering_back_pressure_mpa": raw.get("metering_back_pressure_mpa"),
        "metering_rpm_stages": raw.get("metering_rpm_stages"),
        "metering_switch_positions_mm": raw.get("metering_switch_positions_mm"),
        "cooling_time_s": one("cooling_time_s"),
        "metering_position_mm": one("metering_position_mm"),
        "decompress_position_mm": one("decompress_position_mm"),
        "decompress_mms": one("decompress_mms"),
    }
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
