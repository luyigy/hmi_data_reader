"""B_AND_R（伯乐 BKS/EKS 蓝 UI）温度页提取（026_PLAN S7 自 extract_fields.py 拆出，行为不变）。"""
from .common import _anchor_match, _fit_slope, _num  # noqa: F401


def extract_temperature_b_and_r(toks: list[dict], template: dict) -> dict:
    """B_AND_R（伯乐 B&R 蓝 UI）料筒温度页提取主逻辑。

    表格 6 列（NZ/#1~#5）× 5 数据行（实际温度/设定温度/高温偏差/低温偏差/加热输出），
    页底单值 保温温度。行标签常被 OCR 截字（示温度/定温度/温偏差/热输出），
    「温偏差」按 y 顺序分配高温/低温；列位按 5 行数值 x 一维聚类（期望 6 列）；
    `#N` 列头不进入数值单元格；透视畸变使右侧各行 y2 随 x 整体下移，
    行归属按列网格搜索垂直平移量对齐（行值域先验 + 未分配罚 + |o| 先验），
    整列错位一行以上时告警 COLUMN_SHIFTED。
    基础 OCR 常整行漏检，调用前已合并 CLAHE 变体。返回同 TACT 结构。
    """
    warnings: list[str] = []
    anchors = template["row_anchors"]
    rules = template["validation_rules"]

    def find_labels(keys, xmax=0.35):
        return sorted([t for t in toks if t["x"] < xmax and _anchor_match(keys, t["text"])],
                      key=lambda t: t["y"])

    cur_l = find_labels(anchors["current"])
    set_l = find_labels(anchors["set"])
    high_l = [t for t in toks if t["x"] < 0.35 and "高温偏差" in t["text"]]
    low_l = [t for t in toks if t["x"] < 0.35 and "低温偏差" in t["text"]]
    # 高/低温偏差同被截为「温偏差」时按 y 顺序分配（上=高温、下=低温）
    generic = [t for t in find_labels(anchors["high_low_generic"])
               if "高温偏差" not in t["text"] and "低温偏差" not in t["text"]]
    if not high_l and generic:
        high_l = [generic.pop(0)]
    if not low_l and generic:
        low_l = [generic.pop(0)]
    ctl_l = find_labels(anchors["control"])
    missing = [name for name, ls in [("current", cur_l), ("set", set_l), ("high", high_l),
                                     ("low", low_l), ("control", ctl_l)] if not ls]
    if missing:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ROW_LABELS_NOT_FOUND({','.join(missing)})"], "detail": {}}
    labels = {"current": cur_l[0], "set": set_l[0], "high": high_l[0],
              "low": low_l[0], "control": ctl_l[0]}
    row_names = ["current", "set", "high", "low", "control"]

    # 去斜：加热输出行为基础 OCR 最稳定的一行，用其数值拟合斜率
    ctl_y = labels["control"]["y"]
    ctl_vals = [t for t in toks if _num(t) is not None and t["x"] > 0.12
                and abs(t["y"] - ctl_y) < 0.025]
    k = _fit_slope(ctl_vals)
    if len(ctl_vals) < 4:
        warnings.append(f"DESKEW_INSUFFICIENT_TOKENS({len(ctl_vals)})")
    for t in toks:
        t["y2"] = t["y"] - k * (t["x"] - 0.5)

    row_y = {r: labels[r]["y2"] for r in row_names}
    if not all(row_y[a] < row_y[b] for a, b in zip(row_names, row_names[1:])):
        warnings.append("ROW_ORDER_ABNORMAL")
    min_gap = min(row_y[b] - row_y[a] for a, b in zip(row_names, row_names[1:]))

    # 行归属 + 列聚类（5 行数值合并，期望 6 列）
    # `#N` 列头不进入数值单元格（_num 会把 "#3" 解析成 3.0）；
    # band 下界放宽：透视畸变使右侧各行 y2 随 x 下移可达约一个行距，
    # 加热输出真值会被 0.5*min_gap 的旧下界切掉，先收进来再按列对齐
    g = min_gap
    band = [t for t in toks if _num(t) is not None and t["x"] > 0.12
            and not t["text"].strip().startswith("#")
            and row_y["current"] - 0.75 * g < t["y2"] < row_y["control"] + 1.75 * g]
    xs = sorted(t["x"] for t in band)
    clusters: list[list[float]] = []
    for x in xs:
        if clusters and x - clusters[-1][-1] <= 0.045:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    # 列数自适应（042 S02）：只有 NZ/#1~#4 列头全部可见且 #5 不存在时，才进入
    # B07 五列变体；任何非 NZ 列头缺失都保持六列并告警，不能把缺列误当变体放行。
    headers = {t["text"].replace(" ", "") for t in toks}
    five_columns = all(name in headers for name in ("NZ", "#1", "#2", "#3", "#4")) \
        and "#5" not in headers
    n_cols = 5 if five_columns else 6
    if len(clusters) == n_cols:
        col_centers = [sum(c) / len(c) for c in clusters]
    elif len(clusters) > n_cols:
        # 噪声簇过多：取成员数最多的 n_cols 簇（数据列数值密集，标签残字簇成员少）
        picked = sorted(clusters, key=lambda c: len(c), reverse=True)[:n_cols]
        picked.sort(key=lambda c: sum(c) / len(c))
        col_centers = [sum(c) / len(c) for c in picked]
        warnings.append(f"COLUMN_CLUSTER_PRUNED({len(clusters)}->{n_cols})")
    else:
        # 实测列数 < 期望：非尾列缺失或列结构识别失败，仍按模板兜底 + 告警（review/reject）
        warnings.append(f"COLUMN_CLUSTER_COUNT({len(clusters)}/{n_cols})")
        labels = ("NZ", "#1", "#2", "#3", "#4") if five_columns else \
            ("NZ", "#1", "#2", "#3", "#4", "#5")
        col_centers = [template["layout"]["column_x_centers"][lb] for lb in labels]
        warnings.append("TEMPLATE_COLUMNS_FALLBACK")
    spacing = (col_centers[-1] - col_centers[0]) / (n_cols - 1)
    col_tol = 0.4 * spacing

    # 逐列垂直对齐：行标签锚定在左侧，透视畸变下右侧各行整体平移，
    # 用固定 row_y 全局归属会整列错位一行。对每列在 o ∈ [-0.6g, 1.6g]
    # 网格搜索平移量，得分 = 归属距离和 + 未分配罚 + |o| 先验；行值域为
    # 硬约束（温度进不了偏差行），全行越界的 OCR 误读不可分配（rank12 根因）
    row_ranges = {
        "current": rules["temperature_range_C"],
        "set": rules["temperature_range_C"],
        "high": rules["deviation_range_C"],
        "low": rules["deviation_range_C"],
        "control": rules["control_percent_range"],
    }

    def align_column(col_toks: list[dict]) -> tuple[dict[str, dict], float, int]:
        best = None
        o = -0.6 * g
        while o <= 1.6 * g + 1e-9:
            assigned: dict[str, tuple[float, dict]] = {}
            unassigned = 0
            for t in sorted(col_toks, key=lambda t: t["y2"]):
                v = _num(t)
                cands = [n for n in row_names if row_ranges[n][0] <= v <= row_ranges[n][1]]
                if not cands:
                    unassigned += 1
                    continue
                d, r = min((abs(t["y2"] - (row_y[n] + o)), n) for n in cands)
                if d <= 0.5 * g:
                    if r not in assigned or d < assigned[r][0]:
                        unassigned += r in assigned
                        assigned[r] = (d, t)
                    else:
                        unassigned += 1
                else:
                    unassigned += 1
            score = (sum(d for d, _ in assigned.values())
                     + 0.5 * g * unassigned + 0.05 * abs(o))
            if best is None or score < best[0] - 1e-9:
                best = (score, o, {r: t for r, (_, t) in assigned.items()}, unassigned)
            o += 0.05 * g
        return best[2], best[1], best[3]

    cells: dict[str, dict[int, dict]] = {r: {} for r in row_names}
    for i, cx in enumerate(col_centers):
        col_toks = [t for t in band if abs(t["x"] - cx) <= col_tol]
        if not col_toks:
            continue
        assigned, o_c, n_un = align_column(col_toks)
        for r, t in assigned.items():
            if i not in cells[r] or t["conf"] > cells[r][i]["conf"]:
                cells[r][i] = t
        if not five_columns and abs(o_c) > 0.5 * g:
            warnings.append(f"COLUMN_SHIFTED(col{i + 1},{o_c / g:+.2f}g)")
        if n_un:
            warnings.append(f"COLUMN_ALIGN_UNASSIGNED(col{i + 1},{n_un})")

    def row_values(row: str) -> tuple[list[float | None], list[str]]:
        # 始终输出 6 元数组（契约 zones6）；5 列变体下第 6 位（#5）物理不存在，
        # 记 None 且不告 CELL_MISSING（与真值 #5=null 一致）；中间列漏检仍告警。
        vals, ws = [], []
        for i in range(6):
            if i >= n_cols:
                vals.append(None)
                continue
            t = cells[row].get(i)
            v = _num(t) if t else None
            if v is None:
                ws.append(f"CELL_MISSING({row},col{i + 1})")
            elif t["conf"] < rules["min_cell_conf"]:
                ws.append(f"LOW_CONF({row},col{i + 1},{t['conf']:.2f})")
            vals.append(v)
        return vals, ws

    cur, w1 = row_values("current")
    setv, w2 = row_values("set")
    high, w3 = row_values("high")
    low, w4 = row_values("low")
    ctl, w5 = row_values("control")
    warnings.extend(w1 + w2 + w3 + w4 + w5)

    # 页底保温温度：标签右侧同行的最近数值
    hold_l = find_labels(anchors["holding"], xmax=0.5)
    holding, hold_tok = None, None
    if hold_l:
        hl = hold_l[0]
        cands = [t for t in toks if _num(t) is not None
                 and 0.03 < t["x"] - hl["x"] < 0.35
                 and abs(t["y2"] - hl["y2"]) < 0.02]
        if cands:
            hold_tok = min(cands, key=lambda t: t["x"] - hl["x"])
            holding = _num(hold_tok)
            if hold_tok["conf"] < rules["min_cell_conf"]:
                warnings.append(f"LOW_CONF(holding,{hold_tok['conf']:.2f})")
        else:
            warnings.append("HOLDING_VALUE_NOT_FOUND")
    elif not five_columns:
        warnings.append("HOLDING_LABEL_NOT_FOUND")

    fields = {
        "barrel_temperature_current_c": cur,
        "barrel_temperature_set_c": setv,
        "high_deviation_c": high,
        "low_deviation_c": low,
        "control_percent": ctl,
        "holding_temperature_c": holding,
    }

    # 范围校验
    t_lo, t_hi = rules["temperature_range_C"]
    d_lo, d_hi = rules["deviation_range_C"]
    p_lo, p_hi = rules["control_percent_range"]
    h_lo, h_hi = rules["holding_range_C"]
    for name in ("barrel_temperature_current_c", "barrel_temperature_set_c"):
        for i, v in enumerate(fields[name]):
            if v is not None and not (t_lo <= v <= t_hi):
                warnings.append(f"VALUE_OUT_OF_RANGE({name}[{i}]={v})")
    for name in ("high_deviation_c", "low_deviation_c"):
        for i, v in enumerate(fields[name]):
            if v is not None and not (d_lo <= v <= d_hi):
                warnings.append(f"VALUE_OUT_OF_RANGE({name}[{i}]={v})")
    for i, v in enumerate(fields["control_percent"]):
        if v is not None and not (p_lo <= v <= p_hi):
            warnings.append(f"VALUE_OUT_OF_RANGE(control_percent[{i}]={v})")
    v = fields["holding_temperature_c"]
    if v is not None and not (h_lo <= v <= h_hi):
        warnings.append(f"VALUE_OUT_OF_RANGE(holding_temperature_c={v})")

    # current vs set 一致性（±tol -> review；升降温中的机台会触发，属保守设计）
    tol_c = rules["current_set_consistency_tolerance_C"]
    for i, (cv, sv) in enumerate(zip(cur, setv)):
        if cv is not None and sv is not None and abs(cv - sv) > tol_c:
            warnings.append(f"CURRENT_SET_INCONSISTENT(col{i + 1}: {cv} vs {sv})")

    detail = {
        "columns_measured": [round(c, 4) for c in col_centers],
        "row_centers": {r: round(row_y[r], 4) for r in row_names},
        "deskew_slope": round(k, 4),
        "cells": {r: {str(i): {"text": t["text"], "conf": round(t["conf"], 3)}
                      for i, t in cells[r].items()} for r in row_names},
    }
    return {"fields": fields, "heater_columns": n_cols, "warnings": warnings, "detail": detail}
