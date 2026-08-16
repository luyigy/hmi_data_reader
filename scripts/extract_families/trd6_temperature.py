"""TRD6（沙迪克 Sodick Plustech）温度设定页提取（083 PLAN S07 新增）。

布局（templates/trd6.temperature.json）：上块 Z4/Z5/Z6、下块 Z0/Z1/Z2 两个
三区段块（本布局无 Z3），右侧 ZH 单列（料斗侧温区，~80°C，落下口同义——
TACT 落下口/KEBA 法兰先例），行=现在/设定/警报上限幅/警报下限幅
（左侧竖排行标签 OCR 常碎成两行，故行归属用数值行聚类而非标签文字）；
左缘油温单值；右中「进入保温」值为 holding（0.0=关）。
段序=区号升序 [Z0..Z6]，Z0 实测全表最高温=喷嘴侧（判读假设，profile 注明）。
返回结构同 extract_families.keba。
"""
import re

from .common import _anchor_match, _num  # noqa: F401

ZONE_RE = re.compile(r"^Z[0-9O]$")
ROW_NAMES = ["current", "set", "high", "low"]  # 行序固定：现在/设定/上限幅/下限幅


def _zone_label(text: str) -> str | None:
    t = text.strip()
    if ZONE_RE.match(t):
        return "Z0" if t == "ZO" else t  # OCR 0/O 混淆实测变体
    return None


def _cell(toks, cx, y0, y1, x_tol=0.04):
    cands = [t for t in toks if _num(t) is not None
             and abs(t["x"] - cx) < x_tol and y0 <= t["y"] < y1]
    if not cands:
        return None
    return _num(max(cands, key=lambda t: t["conf"]))


def extract_temperature_trd6(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    anchors = template["row_anchors"]
    rules = template["validation_rules"]

    # 段块：Z0-Z6 列头按 y 聚块（上下两块），块内数值按 y 聚 4 行（现在/设定/上/下限幅）
    headers = [t for t in toks if _zone_label(t["text"]) is not None]
    if not headers:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["ZONE_HEADERS_NOT_FOUND"], "detail": {}}
    headers.sort(key=lambda t: (t["y"], t["x"]))
    blocks: list[list[dict]] = []
    for h in headers:
        if blocks and abs(h["y"] - blocks[-1][-1]["y"]) < 0.1:
            blocks[-1].append(h)
        else:
            blocks.append([h])

    t_lo, t_hi = rules["temperature_range_C"]
    d_lo, d_hi = rules["deviation_range_C"]
    zones: dict[str, dict[str, float | None]] = {}
    for block in blocks:
        hdr_y = min(h["y"] for h in block)
        col_xs = [h["x"] for h in block]
        x_lo, x_hi = min(col_xs) - 0.04, max(col_xs) + 0.04
        nums = [t for t in toks
                if _num(t) is not None and x_lo < t["x"] < x_hi
                and hdr_y + 0.01 < t["y"] < hdr_y + 0.22]
        nums.sort(key=lambda t: t["y"])
        rows: list[list[dict]] = []
        for t in nums:
            if rows and t["y"] - rows[-1][-1]["y"] <= 0.025:
                rows[-1].append(t)
            else:
                rows.append([t])
        if len(rows) < 4:
            warnings.append(f"BLOCK_ROWS_INSUFFICIENT(y={hdr_y:.3f},{len(rows)}/4)")
            continue
        bounds = [rows[0][0]["y"] - 0.015] + [
            (r0[-1]["y"] + r1[0]["y"]) / 2 for r0, r1 in zip(rows, rows[1:])] + [
            rows[-1][-1]["y"] + 0.015]
        for h in block:
            label = _zone_label(h["text"])
            if label in zones:
                warnings.append(f"ZONE_DUPLICATE({label})")
                continue
            vals = {}
            for ri, row_name in enumerate(ROW_NAMES[:4]):
                v = _cell(toks, h["x"], bounds[ri], bounds[ri + 1])
                lo, hi = (t_lo, t_hi) if row_name in ("current", "set") else (d_lo, d_hi)
                if v is not None and not (lo <= v <= hi):
                    warnings.append(f"VALUE_OUT_OF_RANGE({row_name},{label},{v})")
                    v = None
                if v is None:
                    warnings.append(f"CELL_MISSING({label},{row_name})")
                vals[row_name] = v
            zones[label] = vals

    if not zones:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["ZONE_VALUES_NOT_FOUND"], "detail": {}}
    order = sorted(zones, key=lambda z: int(z[1:]))

    # ZH 单列（料斗侧温区 → drop_port 当前/设定；上/下限幅不入 schema）
    drop_cur = drop_set = None
    dp_lo, dp_hi = rules["drop_port_range_C"]
    zh = [t for t in toks if t["text"].strip() == "ZH" and t["y"] < 0.3]
    if zh:
        zx = min(zh, key=lambda t: t["y"])["x"]
        col_vals = sorted([t for t in toks if _num(t) is not None
                           and abs(t["x"] - zx) < 0.05 and t["y"] < 0.45],
                          key=lambda t: t["y"])
        if len(col_vals) >= 2:
            for name, tok in (("current", col_vals[0]), ("set", col_vals[1])):
                v = _num(tok)
                if dp_lo <= v <= dp_hi:
                    if name == "current":
                        drop_cur = v
                    else:
                        drop_set = v
                else:
                    warnings.append(f"VALUE_OUT_OF_RANGE(drop_port,{v})")
        else:
            warnings.append("DROP_PORT_VALUES_MISSING")
    else:
        warnings.append("DROP_PORT_HEADER_NOT_FOUND")

    # 油温：左缘标签右侧同行最近值（单值，无设定行）
    oil = None
    o_lo, o_hi = rules["oil_range_C"]
    oil_lab = [t for t in toks if t["x"] < 0.15
               and _anchor_match(anchors["oil"], t["text"])]
    if oil_lab:
        lab = oil_lab[0]
        cands = [t for t in toks if _num(t) is not None
                 and lab["x"] < t["x"] < lab["x"] + 0.2
                 and abs(t["y"] - lab["y"]) < 0.03 and o_lo <= _num(t) <= o_hi]
        if cands:
            oil = _num(min(cands, key=lambda t: abs(t["y"] - lab["y"])))
    if oil is None:
        warnings.append("OIL_NOT_FOUND")

    # 保温：进入保温 标签右侧同行的值（0.0=关，属合法读数）
    holding = None
    h_lo, h_hi = rules["holding_range_C"]
    h_lab = [t for t in toks if _anchor_match(anchors["holding"], t["text"])]
    if h_lab:
        lab = h_lab[0]
        cands = [t for t in toks if _num(t) is not None and t["x"] > lab["x"]
                 and abs(t["y"] - lab["y"]) < 0.03 and h_lo <= _num(t) <= h_hi]
        if cands:
            holding = _num(min(cands, key=lambda t: (abs(t["y"] - lab["y"]), t["x"])))
    if holding is None:
        warnings.append("HOLDING_NOT_FOUND")

    fields = {
        "barrel_temperature_current_c": [zones[z]["current"] for z in order],
        "barrel_temperature_set_c": [zones[z]["set"] for z in order],
        "high_deviation_c": [zones[z]["high"] for z in order],
        "low_deviation_c": [zones[z]["low"] for z in order],
        "drop_port_temperature_current_c": drop_cur,
        "drop_port_temperature_set_c": drop_set,
        "oil_temperature_current_c": oil,
        "holding_temperature_c": holding,
    }
    detail = {
        "zone_order": order,
        "zone_semantics": "区号升序；Z0 全表最高温=喷嘴侧（判读假设，见 profile 披露）",
        "blocks": [[h["text"] for h in b] for b in blocks],
    }
    return {"fields": fields, "heater_columns": len(order),
            "warnings": warnings, "detail": detail}
