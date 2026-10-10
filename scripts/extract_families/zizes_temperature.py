"""ZizES 温度页字段提取。"""
from __future__ import annotations

import re

from extract_families.common import NUM_RE

DIGIT_HEADER_RE = re.compile(r"[1-9]")


def detect_columns(toks: list[dict], template: dict) -> tuple[list[float] | None, float | None, list[str]]:
    """实测列位：返回 (7 个料筒列 x 中心或 None, 油温列 x 或 None, warnings)。"""
    warnings = []
    oil = [t for t in toks if template["row_anchors"]["oil_header"] in t["text"]]
    if not oil:
        warnings.append("OIL_HEADER_NOT_FOUND")
        return None, None, warnings
    oil_t = oil[0]
    digits = {}
    for t in toks:
        if DIGIT_HEADER_RE.fullmatch(t["text"]) and abs(t["y"] - oil_t["y"]) < 0.03:
            digits[int(t["text"])] = t
    if len(digits) < 4:
        warnings.append(f"HEADER_DIGITS_INSUFFICIENT({len(digits)})")
        return None, oil_t["x"], warnings
    # 线性拟合 x = a*col + b，补齐缺失列头（列头 1 常被漏检）
    idx = sorted(digits)
    n = len(idx)
    mx = sum(idx) / n
    my = sum(digits[i]["x"] for i in idx) / n
    a = sum((i - mx) * (digits[i]["x"] - my) for i in idx) / sum((i - mx) ** 2 for i in idx)
    b = my - a * mx
    # 合理性校验：列距与模板平均列距偏差 > 30% 则回退模板
    if abs(a - template["layout"]["column_spacing_avg"]) > 0.3 * template["layout"]["column_spacing_avg"]:
        warnings.append(f"HEADER_SPACING_ABNORMAL({a:.4f})")
        return None, oil_t["x"], warnings
    return [a * i + b for i in range(1, 8)], oil_t["x"], warnings


def deskew_slope(toks: list[dict], oil_t_text: str) -> float:
    """用列头行（数字 + 油温）拟合 y = k*(x-0.5) + c 的斜率 k，用于去斜。"""
    header = [t for t in toks
              if (DIGIT_HEADER_RE.fullmatch(t["text"]) or oil_t_text in t["text"])]
    if len(header) < 3:
        return 0.0
    ys = [t["y"] for t in header]
    hy = sum(ys) / len(ys)
    header = [t for t in header if abs(t["y"] - hy) < 0.03]
    if len(header) < 3:
        return 0.0
    mx = sum(t["x"] for t in header) / len(header)
    my = sum(t["y"] for t in header) / len(header)
    denom = sum((t["x"] - mx) ** 2 for t in header)
    if denom < 1e-6:
        return 0.0
    return sum((t["x"] - mx) * (t["y"] - my) for t in header) / denom


def extract_temperature(toks: list[dict], template: dict) -> dict:
    """ZizES 温度页提取主逻辑。返回 {fields, heater_columns, warnings, detail}。"""
    warnings: list[str] = []
    anchors = template["row_anchors"]
    layout = template["layout"]
    rules = template["validation_rules"]
    disabled_marks = set(template["heater_columns"]["disabled_marks"])

    # 列位（实测优先，模板兜底）
    cols, oil_x, col_warns = detect_columns(toks, template)
    warnings.extend(col_warns)
    if cols is None:
        warnings.append("TEMPLATE_COLUMNS_FALLBACK")
    if oil_x is None:
        oil_x = layout["column_x_centers"]["oil"]
    if cols is not None:
        spacing = cols[1] - cols[0]
        col_tol = spacing / 2

    # 去斜 + 行锚点
    k = deskew_slope(toks, anchors["oil_header"])
    for t in toks:
        t["y2"] = t["y"] - k * (t["x"] - 0.5)
    set_anchor = [t for t in toks if anchors["set"] in t["text"]]
    ctl_anchor = [t for t in toks if anchors["control"] in t["text"]]
    oil_anchor = [t for t in toks if anchors["oil_header"] in t["text"]]
    if not (set_anchor and ctl_anchor and oil_anchor):
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["ROW_ANCHORS_NOT_FOUND"], "detail": {}}
    header_y = oil_anchor[0]["y2"]
    set_y = set_anchor[0]["y2"]
    ctl_y = ctl_anchor[0]["y2"]
    row_tol = layout["row_y_tolerance"]

    # 数据区 token：去斜后落在 (列头行, 控制行+tol] 内
    band = [t for t in toks if header_y + 0.01 < t["y2"] <= ctl_y + row_tol]
    label_tokens = [t for t in band if anchors["set"] in t["text"] or anchors["control"] in t["text"]]
    value_tokens = [t for t in band if t not in label_tokens]

    # 一维 y 聚类 -> 当前/设定/控制 3 行
    ys = sorted(t["y2"] for t in value_tokens)
    clusters: list[list[float]] = []
    for y in ys:
        if clusters and y - clusters[-1][-1] <= row_tol:
            clusters[-1].append(y)
        else:
            clusters.append([y])
    if len(clusters) != 3:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ROW_CLUSTER_COUNT({len(clusters)})"], "detail": {}}
    row_names = ["current", "set", "control"]
    row_centers = {name: sum(c) / len(c) for name, c in zip(row_names, clusters)}
    # 锚点校验：set/control 聚类中心应与标签 y 接近
    if abs(row_centers["set"] - set_y) > row_tol or abs(row_centers["control"] - ctl_y) > row_tol:
        warnings.append("ROW_ANCHOR_MISMATCH")

    if cols is None:
        # 数字列头不足时的油温锚定回退（083 S01）：模板绝对列位在屏变体间
        # 平移/缩放漂移（实测 rec201/jiaming 油温列 x 漂移近一个列距），直接兜底
        # 会整行错列。改对数据区值 token 做一维 x 聚类：与实测油温列 x 对齐的
        # 簇为油温列，其左连续等距簇为料筒 1..N 列（不足 7 列按中位列距右补）；
        # 簇结构不完整才退模板绝对列位。
        tpl_spacing = layout["column_spacing_avg"]
        xs = sorted(t["x"] for t in value_tokens if NUM_RE.search(t["text"]))
        clusters_x: list[list[float]] = []
        for x in xs:
            if clusters_x and x - clusters_x[-1][-1] <= 0.3 * tpl_spacing:
                clusters_x[-1].append(x)
            else:
                clusters_x.append([x])
        centers = [sum(c) / len(c) for c in clusters_x]
        anchored = None
        if centers:
            d_oil, i_oil = min((abs(c - oil_x), i) for i, c in enumerate(centers))
            barrel = centers[:i_oil]
            gaps = [b - a for a, b in zip(barrel, barrel[1:])]
            if 5 <= len(barrel) <= 7 and gaps:
                med = sorted(gaps)[len(gaps) // 2]
                if (d_oil <= 0.6 * med
                        and all(g <= 1.5 * med for g in gaps)
                        and abs(med - tpl_spacing) <= 0.3 * tpl_spacing):
                    anchored = barrel + [barrel[-1] + med * j
                                         for j in range(1, 8 - len(barrel))]
        if anchored is None:
            cols = [layout["column_x_centers"][str(i)] for i in range(1, 8)]
        else:
            cols = anchored
            warnings.append("OIL_ANCHORED_COLUMNS")
        spacing = cols[1] - cols[0]
        col_tol = spacing / 2

    def row_of(t: dict) -> str | None:
        best, best_d = None, row_tol
        for name, c in row_centers.items():
            d = abs(t["y2"] - c)
            if d <= best_d:
                best, best_d = name, d
        return best

    def col_of(t: dict) -> int | None:
        """返回 1..7（料筒列）或 8（油温列）或 None。"""
        cands = [(abs(t["x"] - cx), i + 1) for i, cx in enumerate(cols)]
        cands.append((abs(t["x"] - oil_x), 8))
        d, i = min(cands)
        return i if d <= col_tol else None

    # 单元格填充：cells[row][col] = token
    def put_cell(row: str, col: int, t: dict) -> None:
        # 同格多 token 取先到的（更高 conf 通常先检出）；083 S13 例外——主 OCR
        # 对红字数码格截尾漏小数位（'290.2'->'290'、'2.9'->'2'），后到 token
        # 小数完整且以截尾读数为前缀（'290.2'/'2.9'）时替换为完整读数；
        # 其余冲突维持既有「先到优先」口径。
        cur = cells[row].get(col)
        if cur is None:
            cells[row][col] = t
            return
        m_cur, m_new = NUM_RE.search(cur["text"]), NUM_RE.search(t["text"])
        if (m_cur and m_new and not re.fullmatch(r"\d+\.\d+", m_cur.group())
                and "." in m_new.group()
                and m_new.group().startswith(m_cur.group())):
            cells[row][col] = t

    cells: dict[str, dict[int, dict]] = {r: {} for r in row_names}
    for t in value_tokens:
        r, c = row_of(t), col_of(t)
        if r and c:
            put_cell(r, c, t)
    # 行标签合并 token（如 '设定°C262.0'）：数值强制归该行第 1 个空格
    for t in label_tokens:
        if not NUM_RE.search(t["text"]):
            continue
        r = row_of(t) or ("set" if anchors["set"] in t["text"] else "control")
        for c in range(1, 9):
            if c not in cells[r]:
                cells[r][c] = t
                break

    def cell_number(row: str, col: int) -> tuple[float | None, dict | None]:
        t = cells[row].get(col)
        if t is None:
            return None, None
        m = NUM_RE.search(t["text"])
        return (float(m.group()) if m else None), t

    # 启用段数：当前值行从第 1 列起连续数值列
    heater_columns = 0
    gap_seen = False
    for c in range(1, 8):
        v, t = cell_number("current", c)
        if v is not None:
            if gap_seen:
                warnings.append(f"HEATER_GAP_BEFORE_COL{c}")
            heater_columns = c
        else:
            gap_seen = True  # 空缺或 */水 标记 -> 未启用
    if heater_columns == 0:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["NO_ENABLED_HEATER_COLUMN"], "detail": {}}

    # 组装字段
    def row_values(row: str, cols_needed: list[int]) -> tuple[list[float | None], list[str]]:
        vals, ws = [], []
        for c in cols_needed:
            v, t = cell_number(row, c)
            if v is None:
                ws.append(f"CELL_MISSING({row},col{c})")
            elif not re.fullmatch(r"\d+\.\d+", NUM_RE.search(t["text"]).group()):
                # 083 S13：ZizES 温度页数值恒带一位小数（含 0.0）；无小数点读数
                # 或尾点读数必是 OCR 截尾（'290.2'->'290'/'290.'、'2.9'->'2'），静默补 .0 会写
                # 错值——置缺并告警，触发逐格重读救援回补，宁缺不错。
                ws.append(f"DECIMAL_TRUNCATED({row},col{c}:{t['text']})")
                v = None
            elif t["conf"] < rules["min_cell_conf"]:
                ws.append(f"LOW_CONF({row},col{c},{t['conf']:.2f})")
            vals.append(v)
        return vals, ws

    barrel_cols = list(range(1, heater_columns + 1))
    cur, w1 = row_values("current", barrel_cols)
    setv, w2 = row_values("set", barrel_cols)
    ctl, w3 = row_values("control", barrel_cols)
    oil_cur, w4 = row_values("current", [8])
    oil_set, w5 = row_values("set", [8])
    warnings.extend(w1 + w2 + w3 + w4 + w5)

    fields = {
        "barrel_temperature_current_c": cur,
        "barrel_temperature_set_c": setv,
        "oil_temperature_current_c": oil_cur[0],
        "oil_temperature_set_c": oil_set[0],
        "control_percent": ctl,
    }

    # 范围校验
    t_lo, t_hi = rules["temperature_range_C"]
    p_lo, p_hi = rules["control_percent_range"]
    for name in ("barrel_temperature_current_c", "barrel_temperature_set_c"):
        for i, v in enumerate(fields[name]):
            if v is not None and not (t_lo <= v <= t_hi):
                warnings.append(f"VALUE_OUT_OF_RANGE({name}[{i}]={v})")
    for name in ("oil_temperature_current_c", "oil_temperature_set_c"):
        v = fields[name]
        if v is not None and not (t_lo <= v <= t_hi):
            warnings.append(f"VALUE_OUT_OF_RANGE({name}={v})")
    for i, v in enumerate(fields["control_percent"]):
        if v is not None and not (p_lo <= v <= p_hi):
            warnings.append(f"VALUE_OUT_OF_RANGE(control_percent[{i}]={v})")

    # current vs set 一致性（±tol，超出 -> review；真实报警态也会触发，属保守设计）
    tol_c = rules["current_set_consistency_tolerance_C"]
    for i, (cv, sv) in enumerate(zip(fields["barrel_temperature_current_c"],
                                     fields["barrel_temperature_set_c"])):
        if cv is not None and sv is not None and abs(cv - sv) > tol_c:
            warnings.append(f"CURRENT_SET_INCONSISTENT(col{i + 1}: {cv} vs {sv})")

    detail = {
        "columns_measured": [round(c, 4) for c in cols] + [round(oil_x, 4)],
        "row_centers": {r: round(c, 4) for r, c in row_centers.items()},
        "deskew_slope": round(k, 4),
        "cells": {r: {str(c): {"text": t["text"], "conf": round(t["conf"], 3)}
                      for c, t in cells[r].items()} for r in row_names},
    }
    return {"fields": fields, "heater_columns": heater_columns,
            "warnings": warnings, "detail": detail}
