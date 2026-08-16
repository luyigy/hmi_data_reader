"""B_AND_R（伯乐 BKS/EKS 蓝 UI）温度页提取（026_PLAN S7 自 extract_fields.py 拆出，行为不变）。"""
from itertools import combinations

from .common import _affine_fit_columns, _anchor_match, _fit_slope, _num  # noqa: F401


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
    high_l = find_labels(anchors["high"])
    low_l = find_labels(anchors["low"])
    # 高/低温偏差同被截为「温偏差」时按 y 顺序分配（上=高温、下=低温）
    generic = [t for t in find_labels(anchors["high_low_generic"])
               if t not in high_l and t not in low_l]
    if not high_l and generic:
        high_l = [generic.pop(0)]
    if not low_l and generic:
        low_l = [generic.pop(0)]
    ctl_l = find_labels(anchors["control"])
    found = {"current": cur_l, "set": set_l, "high": high_l,
             "low": low_l, "control": ctl_l}
    row_names = ["current", "set", "high", "low", "control"]
    missing = [name for name in row_names if not found[name]]
    if len(missing) == 1:
        # 083 S03：整表仅缺一个行标签（OCR 把「实际温度」整行吞成杂字）时，
        # 五行行序固定、行距机械均匀——用其余四个标签的间距中位数外推/内插
        # 缺失行的 y，并留 ROW_LABEL_INFERRED 告警强制复核；行距不均匀
        # （拍照缺行/重影）时不猜，维持拒识。
        name = missing[0]
        present = [(i, found[n][0]["y"]) for i, n in enumerate(row_names) if found[n]]
        pitches = [(y2 - y1) / (j - i) for (i, y1), (j, y2) in zip(present, present[1:])]
        med = sorted(pitches)[len(pitches) // 2]
        if (len(pitches) >= 2 and med > 0
                and all(0.6 * med <= p <= 1.5 * med for p in pitches)):
            m_idx = row_names.index(name)
            i0, y0 = min(present, key=lambda e: abs(e[0] - m_idx))
            inferred = {"text": f"<inferred:{name}>", "x": 0.15,
                        "y": y0 + (m_idx - i0) * med, "conf": 0.0}
            toks.append(inferred)
            found[name] = [inferred]
            warnings.append(f"ROW_LABEL_INFERRED({name})")
            missing = []
        else:
            missing = [name for name in row_names if not found[name]]
    if missing:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ROW_LABELS_NOT_FOUND({','.join(missing)})"], "detail": {}}
    labels = {n: found[n][0] for n in row_names}

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
    # 083 S06：'#6' 列头可见时为七列变体（NZ/#1~#6，500EKS 竖屏实拍复现，
    # 此前 7 簇被 COLUMN_CLUSTER_PRUNED 裁成 6 列丢 #6 全列）；输出 7 元数组
    # 并置 detail.page_variant=fixed7（契约 profile 同名单独登记，web 按
    # entity.columns NZ/#1~#6 映射）。'#6' 缺失时维持原 5/6 列口径。
    seven_columns = "#6" in headers
    n_cols = 7 if seven_columns else (5 if five_columns else 6)
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
        labels_all = (("NZ", "#1", "#2", "#3", "#4", "#5", "#6") if seven_columns
                      else ("NZ", "#1", "#2", "#3", "#4", "#5"))
        tpl_centers = template["layout"]["column_x_centers"]
        measured = [sum(c) / len(c) for c in clusters]
        fitted = None
        if not five_columns and 3 <= len(measured) < n_cols:
            # 083 S03：实测列数不足时的有序仿射配准。裸模板列位在透视/裁切漂移的
            # 整机照片上整体错位（列容差 0.4*spacing 吸不到任何值）退化为全缺；
            # 改为：列头 token（NZ/#N）锚定实测簇序（至少一个锚点，防 5 簇在
            # 「真 5 列」与「6 列缺首列」之间误选），缺列组合按最小二乘仿射
            # 残余择优，缺失列用拟合中心；拟合不可信时维持原模板兜底。
            hdr_anchors: dict[int, str] = {}
            for t in toks:
                name = t["text"].replace(" ", "")
                if name in labels_all and t["y2"] < row_y["current"]:
                    j = min(range(len(measured)),
                            key=lambda jj: abs(measured[jj] - t["x"]))
                    if abs(measured[j] - t["x"]) <= 0.05:
                        hdr_anchors[j] = name
            if len(set(hdr_anchors.values())) != len(hdr_anchors):
                hdr_anchors = {}
            if hdr_anchors:
                best = None
                for sub in combinations(range(len(labels_all)), len(measured)):
                    if any(j in hdr_anchors and labels_all[sub[j]] != hdr_anchors[j]
                           for j in range(len(measured))):
                        continue
                    xs = [tpl_centers[labels_all[s]] for s in sub]
                    n = len(xs)
                    mx, my = sum(xs) / n, sum(measured) / n
                    denom = sum((x - mx) ** 2 for x in xs)
                    if denom <= 0:
                        continue
                    a = sum((xs[i] - mx) * (measured[i] - my)
                            for i in range(n)) / denom
                    b = my - a * mx
                    if not 0.5 <= a <= 1.7:
                        continue
                    resid = sum(abs(a * xs[i] + b - measured[i])
                                for i in range(n)) / n
                    if best is None or resid < best[0]:
                        best = (resid, a, b, sub)
                if best and best[0] <= 0.02:
                    resid, a, b, sub = best
                    col_centers = [a * tpl_centers[lb] + b for lb in labels_all]
                    missing = [lb for j, lb in enumerate(labels_all) if j not in sub]
                    fitted = col_centers
                    warnings.append(
                        f"COLUMN_AFFINE_FIT(missing={','.join(missing)},"
                        f"resid={resid:.4f})")
            elif len(measured) >= 3:
                # 083 S05：列头 token 也缺失（竖屏整机实拍主 OCR 丢字）时的
                # 无锚仿射配准（共享助手）——首列须在行标签右缘之右且通过约束
                # 的组合唯一才采信，否则维持模板兜底，不把猜测列位写进结果。
                label_right = max((labels[r].get("x1") or 0.0) for r in row_names)
                if label_right > 0:
                    fit = _affine_fit_columns(
                        measured, [tpl_centers[lb] for lb in labels_all],
                        x_min=label_right)
                    if fit is not None:
                        col_centers, miss_idx = fit
                        fitted = col_centers
                        warnings.append(
                            "COLUMN_AFFINE_UNANCHORED(missing="
                            + ",".join(labels_all[j] for j in miss_idx) + ")")
        if fitted is None:
            labels = ("NZ", "#1", "#2", "#3", "#4") if five_columns else labels_all
            col_centers = [tpl_centers[lb] for lb in labels]
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
                if not cands and v is not None and "." not in t["text"] and v > 0:
                    # 083 S03：OCR 丢小数点致原值越出所有行值域（2752->275.2、
                    # 533->53.3，同 TACT DECIMAL_RESTORED 口径）——仅 /10 后落回
                    # 某行值域才参与归属并留告警强制复核，不静默改值。
                    v10 = v / 10
                    cands10 = [n for n in row_names
                               if row_ranges[n][0] <= v10 <= row_ranges[n][1]]
                    if cands10:
                        t["_v"] = v10
                        t["_dec"] = True
                        v = v10
                        cands = cands10
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
            cur = cells[r].get(i)
            if cur is None:
                cells[r][i] = t
            elif (cur.get("src") == "br_cell") != (t.get("src") == "br_cell"):
                # 主/变体 OCR 优先于逐格重读旁车（033 修复3「主 OCR 值优先」口径）
                if cur.get("src") == "br_cell":
                    cells[r][i] = t
            elif t["conf"] > cur["conf"]:
                cells[r][i] = t
        if not five_columns and abs(o_c) > 0.5 * g:
            warnings.append(f"COLUMN_SHIFTED(col{i + 1},{o_c / g:+.2f}g)")
        if n_un:
            warnings.append(f"COLUMN_ALIGN_UNASSIGNED(col{i + 1},{n_un})")

    def row_values(row: str) -> tuple[list[float | None], list[str]]:
        # 5/6 列页始终输出 6 元数组（契约 zones6）；5 列变体下第 6 位（#5）物理
        # 不存在，记 None 且不告 CELL_MISSING（与真值 #5=null 一致）；083 S06
        # 七列变体（fixed7）输出 7 元数组；中间列漏检仍告警。
        vals, ws = [], []
        for i in range(7 if seven_columns else 6):
            if i >= n_cols:
                vals.append(None)
                continue
            t = cells[row].get(i)
            v = (t.get("_v") if t.get("_dec") else _num(t)) if t else None
            if v is None:
                ws.append(f"CELL_MISSING({row},col{i + 1})")
            else:
                if t.get("_dec"):
                    ws.append(f"DECIMAL_RESTORED({row},col{i + 1}:{_num(t)}->{v})")
                if t["conf"] < rules["min_cell_conf"]:
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
    if seven_columns:
        # 083 S06：七列变体经 extraction_detail.page_variant 透出（同 mold_temp
        # 口径），attach_contract 据此解析 layout_variant=fixed7。
        detail["page_variant"] = "fixed7"
    return {"fields": fields, "heater_columns": n_cols, "warnings": warnings, "detail": detail}
