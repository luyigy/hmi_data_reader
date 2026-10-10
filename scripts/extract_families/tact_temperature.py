"""TACT 温度页字段提取。"""
from __future__ import annotations

import re

from extract_families.common import NUM_RE, norm_cjk


def extract_temperature_tact(toks: list[dict], template: dict) -> dict:
    """TACT 温度页提取主逻辑（5 段料筒 + 落下口独立列，设定/现在/控制/保温 4 行）。

    与 ZizES 的差异：列头是区段中文名（喷嘴/筒头/前部/中部/后部/落下口）而非数字+油温；
    行标签（设定温度/现在温度/控制输出/保温温度）直接给出 4 行锚点，无需 y 聚类；
    落下口只有设定/现在/控制三行。返回 {fields, heater_columns, warnings, detail}。
    """
    warnings: list[str] = []
    anchors = template["row_anchors"]
    layout = template["layout"]
    rules = template["validation_rules"]
    zones = template["zone_labels"]
    drop = template["drop_port_label"]
    row_names = ["set", "current", "control", "holding"]

    # TACT5 变体（083 S01）：末段列头带序号（后部1/后部2），模板固定标签“后部”
    # 子串命中“后部1”会把后部2 整列挤进落下口外推列。实测到编号列头时按序展开。
    numbered = sorted({m.group(0) for t in toks
                       if (m := re.fullmatch(r"后部\s*\d", norm_cjk(t["text"]).strip()))},
                      key=lambda s: int(re.search(r"\d", s).group()))
    if numbered:
        zones = [z for z in zones if z != "后部"] + numbered
        warnings.append(f"ZONE_VARIANT(编号末段:{'/'.join(numbered)})")

    # 列位：区段中文列头实测；中间段整列不存在按实际段数提取（变体自适应，033）；
    # 边缘段（喷嘴/落下口）缺失按实测列距中位数外推（变体布局下模板坐标不可用）
    col_x: dict[str, float] = {}
    header_toks = []
    missing_labels = []
    for label in zones + [drop]:
        hits = [t for t in toks if label in norm_cjk(t["text"])]
        if hits:
            col_x[label] = hits[0]["x"]
            header_toks.append(hits[0])
        else:
            missing_labels.append(label)
    mid_missing = [m for m in missing_labels if m in zones[1:-1]]
    # 083 S07：左缘连续缺失前缀（反光/裁切连丢 喷嘴+筒头 两列头）逐列向左
    # 等距外推——每列须有自己的数值列证据（列头行下方 ≥2 个数值 token，
    # 防虚构列），并吸附证据 token 的中位 x（多列等距外推的累积偏差可达
    # 半个列距）。单列前缀缺失维持原有单格外推口径不变。
    prefix_missing = []
    for m in zones:
        if m in missing_labels:
            prefix_missing.append(m)
        else:
            break
    if len(prefix_missing) >= 2 and len(col_x) >= 3:
        xs0 = sorted(col_x.values())
        gaps0 = sorted(b - a for a, b in zip(xs0, xs0[1:]))
        gap0 = gaps0[len(gaps0) // 2] if gaps0 else 0.1
        header_y0 = min(t["y"] for t in header_toks)
        snapped: dict[str, float] = {}
        for i, m in enumerate(reversed(prefix_missing)):
            x_c = min(xs0) - gap0 * (i + 1)
            ev = [t for t in toks if NUM_RE.search(t["text"])
                  and abs(t["x"] - x_c) < 0.45 * gap0 and t["y"] > header_y0 + 0.01]
            if len(ev) < 2:
                snapped = {}
                break
            snapped[m] = sorted(t["x"] for t in ev)[len(ev) // 2]
        if snapped:
            for m, x in snapped.items():
                col_x[m] = x
                warnings.append(f"ZONE_HEADER_EXTRAPOLATED({m})")
            missing_labels = [m for m in missing_labels if m not in snapped]
            mid_missing = [m for m in mid_missing if m not in snapped]
    if mid_missing and len(header_toks) >= 4:
        # 083 S09：中间段列头淡出（老化屏整字丢失，如 Z077 '筒头' 头无 OCR 命中
        # 但该列设定/现在/控制/保温数值完整）先证据重建再判变体，三重证据缺一不可：
        # 1) 物理列距校验——其余相邻实测列的列头列距中位为基准 pitch，目标缺口
        #    列头距离 round(gap/pitch) 须达到区间段索引距（Z011 喷嘴/前部为相邻
        #    真列，gap≈1 pitch，筒头物理不存在，维持塌缩；Z077 gap≈2 pitch 才重建）；
        # 2) 数据列插值——列头标签相对数据按钮有系统性左偏，用各列带小数点数据
        #    token 中位 x（数据列中心）插值期望列位（TACT 四行数据恒一位小数；
        #    温度计整数刻度分布于列窗左缘，混入会拉偏中位 x 致相邻列串列）；
        # 3) 孤儿数值列——期望列位 ±0.45 列距窗内列头行下方 ≥3 个带小数点数据
        #    token，且均不落在任一实测列的数据列容差内（防相邻列数据扩散成幻影）。
        # 任一不满足则按原口径塌缩为变体，行为与修复前一致。
        hy0 = min(t["y"] for t in header_toks)

        def _data_cx(c: str) -> float:
            xs_d = sorted(t["x"] for t in toks
                          if NUM_RE.search(t["text"]) and "." in t["text"]
                          and abs(t["x"] - col_x[c]) < 0.04 and t["y"] > hy0 + 0.01)
            return xs_d[len(xs_d) // 2] if xs_d else col_x[c]

        found = [(idx, z) for idx, z in enumerate(zones) if z in col_x]
        pitches = [(col_x[z2] - col_x[z1]) / (i2 - i1)
                   for (i1, z1), (i2, z2) in zip(found, found[1:])
                   if col_x[z2] > col_x[z1]]
        pitch = sorted(pitches)[len(pitches) // 2] if pitches else 0.0

        for m in list(mid_missing):
            i = zones.index(m)
            left = next((j for j in range(i - 1, -1, -1) if zones[j] in col_x), None)
            right = next((j for j in range(i + 1, len(zones)) if zones[j] in col_x), None)
            if left is None or right is None or pitch <= 0:
                continue
            # 物理列距校验：缺口实测距离按基准 pitch 折算的物理段数须覆盖
            # 区间段索引距，否则该段物理不存在（真变体），直接留给塌缩
            if round((col_x[zones[right]] - col_x[zones[left]]) / pitch) < right - left:
                continue
            left_cx, right_cx = _data_cx(zones[left]), _data_cx(zones[right])
            col_gap = (right_cx - left_cx) / (right - left)
            if col_gap <= 0:
                continue
            x_c = left_cx + col_gap * (i - left)
            ev = [t for t in toks if NUM_RE.search(t["text"]) and "." in t["text"]
                  and abs(t["x"] - x_c) < 0.45 * col_gap and t["y"] > hy0 + 0.01]
            ev = [t for t in ev
                  if all(abs(t["x"] - _data_cx(c)) >= 0.45 * col_gap for c in col_x)]
            if len(ev) >= 3:
                col_x[m] = sorted(t["x"] for t in ev)[len(ev) // 2]
                warnings.append(f"ZONE_HEADER_REBUILT({m})")
                mid_missing.remove(m)
                missing_labels.remove(m)
        for m in mid_missing:
            zones = [z for z in zones if z != m]
            warnings.append(f"ZONE_VARIANT({len(zones)}段,无{m})")
        missing_labels = [m for m in missing_labels if m not in mid_missing]
    if missing_labels and len(col_x) >= 3:
        xs = sorted(col_x.values())
        gaps = sorted(b - a for a, b in zip(xs, xs[1:]))
        gap = gaps[len(gaps) // 2] if gaps else 0.1
        for m in missing_labels:
            if m == zones[0]:
                x_e = xs[0] - gap
                # 083 S08：单列左缘外推吸附证据中位 x（同 S07 多列前缀口径）——
                # 纯几何外推 xs[0]-gap 对格宽/尾缀字符导致的 token 中心散布
                # 敏感，会在半列距容差边缘把同列宽格（'250.0:'）挤出列；
                # 须列头行下方 ≥2 个数值 token 证据才吸附，否则维持几何外推。
                hy0 = min(t["y"] for t in header_toks)
                ev = [t for t in toks if NUM_RE.search(t["text"])
                      and abs(t["x"] - x_e) < 0.45 * gap and t["y"] > hy0 + 0.01]
                if len(ev) >= 2:
                    x_e = sorted(t["x"] for t in ev)[len(ev) // 2]
                col_x[m] = x_e
                xs.insert(0, col_x[m])
                warnings.append(f"ZONE_HEADER_EXTRAPOLATED({m})")
            elif m == drop:
                col_x[m] = xs[-1] + gap
                xs.append(col_x[m])
                warnings.append(f"ZONE_HEADER_EXTRAPOLATED({m})")
            else:
                col_x[m] = layout["column_x_centers"][m]
                warnings.append(f"ZONE_HEADER_FALLBACK({m})")
    else:
        for m in missing_labels:
            col_x[m] = layout["column_x_centers"][m]
            warnings.append(f"ZONE_HEADER_FALLBACK({m})")
    if len(header_toks) < 4:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"COLUMN_HEADERS_NOT_FOUND({len(header_toks)})"], "detail": {}}

    # 去斜：区段列头行拟合 y = k*(x-0.5) + c（同 ZizES 的 deskew_slope 思路）
    k = 0.0
    if len(header_toks) >= 3:
        mx = sum(t["x"] for t in header_toks) / len(header_toks)
        my = sum(t["y"] for t in header_toks) / len(header_toks)
        denom = sum((t["x"] - mx) ** 2 for t in header_toks)
        if denom > 1e-6:
            k = sum((t["x"] - mx) * (t["y"] - my) for t in header_toks) / denom
    for t in toks:
        t["y2"] = t["y"] - k * (t["x"] - 0.5)

    # 行位：行标签实测，缺失回退模板坐标
    row_y: dict[str, float] = {}
    label_toks = []
    fallback_rows = []
    for name in row_names:
        hits = [t for t in toks if anchors[name] in norm_cjk(t["text"])]
        if hits:
            row_y[name] = hits[0]["y2"]
            label_toks.append(hits[0])
        else:
            row_y[name] = layout["row_y_centers"][name]
            fallback_rows.append(name)
            warnings.append(f"ROW_LABEL_FALLBACK({name})")
    if 0 < len(label_toks) < 3:
        # 083 S08：行标签部分缺失（老化发黄/反光仅余 1-2 个锚，'保温温度' 被误读为
        # '温温货' 等不再命中锚文本）不再直接硬拒——用段列数值簇重建行位并以实测
        # 锚点交叉校验：逐列 y2 聚类后仅保留「前 4 簇为 温度/温度/百分比/温度
        # 签名」的干净段列（落下口仅 3 行、其温度计刻度易凑出幻影第 4 簇，不参与；
        # 缺格列因簇错位过不了签名，自我排除），≥3 个干净列取逐行中位得重建行位；
        # 每个实测标签须落在对应重建行位 ±max(row_tol, 0.5g) 内（g 为干净列相邻
        # 簇距中位），否则维持原硬拒。校验通过也只回填补缺失行，不覆盖实测行位。
        hy1 = sum(t["y2"] for t in header_toks) / len(header_toks)
        p_lo1, p_hi1 = rules["control_percent_range"]
        t_lo1, t_hi1 = rules["temperature_range_C"]

        def _row_sig_ok(rows_c: list[list[dict]]) -> bool:
            for ri, kind in ((0, "t"), (1, "t"), (2, "p"), (3, "t")):
                for t in rows_c[ri]:
                    raw = NUM_RE.search(t["text"]).group()
                    v = float(raw)
                    if kind == "p":
                        if not (p_lo1 <= v <= p_hi1 or
                                ("." not in raw and p_lo1 <= v / 10 <= p_hi1)):
                            return False
                    elif not (t_lo1 <= v <= t_hi1 or
                              ("." not in raw and len(raw) == 4
                               and t_lo1 <= v / 10 <= t_hi1)):
                        # 4 位无点还原形态（'3451'->345.1）只作行签名证据；
                        # 单元格取值仍走既有 _cell_eligible 形态罚分
                        return False
            return True

        clean: list[list[float]] = []
        for c in zones:
            ct = sorted([t for t in toks if NUM_RE.search(t["text"])
                         and abs(t["x"] - col_x[c]) <= 0.05 and t["y2"] > hy1 + 0.01],
                        key=lambda t: t["y2"])
            rows_c: list[list[dict]] = []
            for t in ct:
                if rows_c and t["y2"] - rows_c[-1][-1]["y2"] <= 0.02:
                    rows_c[-1].append(t)
                else:
                    rows_c.append([t])
            if len(rows_c) >= 4 and _row_sig_ok(rows_c):
                clean.append([rows_c[i][0]["y2"] for i in range(4)])
        rebuilt = None
        if len(clean) >= 3:
            med = [sorted(r[i] for r in clean)[len(clean) // 2] for i in range(4)]
            gaps = sorted(b - a for r in clean for a, b in zip(r, r[1:]))
            tol_a = max(layout["row_y_tolerance"], 0.5 * gaps[len(gaps) // 2])
            if all(abs(med[row_names.index(n)] - row_y[n]) <= tol_a
                   for n in row_names if n not in fallback_rows):
                rebuilt = med
        if rebuilt is None:
            return {"fields": None, "heater_columns": 0,
                    "warnings": warnings + [f"ROW_LABELS_NOT_FOUND({len(label_toks)})"],
                    "detail": {}}
        for ri, name in enumerate(row_names):
            if name in fallback_rows:
                row_y[name] = rebuilt[ri]
        warnings.append(
            f"ROW_LABELS_ANCHORED_REBUILD(found={len(label_toks)},cols={len(clean)})")
    if not label_toks:
        # 083 S07：行标签整体缺失（五段变体标签列被反光/裁切整列丢失）不再硬拒——
        # 先按模板行位回退（既有 ROW_LABEL_FALLBACK 逐行口径），再用列跨距内数值
        # token 的 y2 聚类重建行位：列头行下方前 4 个行簇即 set/current/control/
        # holding（行序固定），第 3 簇须全为百分比值域（控制行签名）——本变体
        # 温度计刻度行恰好落在模板保温行位，仅靠模板行位会整行错位。
        warnings.append("ROW_LABELS_ALL_FALLBACK")
        hy = sum(t["y2"] for t in header_toks) / len(header_toks)
        # 逐列聚类再取跨列中位：同列内 token 无去斜残差，行簇干净
        # （整表混合聚类会被行内 y2 扩散与相邻行间距倒置误并）
        p_lo2, p_hi2 = rules["control_percent_range"]
        per_col: list[list[float]] = []
        for c in zones + [drop]:
            ct = sorted([t for t in toks if NUM_RE.search(t["text"])
                         and abs(t["x"] - col_x[c]) <= 0.05 and t["y2"] > hy + 0.01],
                        key=lambda t: t["y2"])
            rows_c: list[list[dict]] = []
            for t in ct:
                if rows_c and t["y2"] - rows_c[-1][-1]["y2"] <= 0.02:
                    rows_c[-1].append(t)
                else:
                    rows_c.append([t])
            if len(rows_c) >= 4:
                per_col.append(rows_c)
        if len(per_col) >= 4:
            ctl_texts = [t["text"] for rows_c in per_col for t in rows_c[2]]
            ctl_ok = True
            for text in ctl_texts:
                raw = NUM_RE.search(text).group()
                v = float(raw)
                if not (p_lo2 <= v <= p_hi2 or
                        ("." not in raw and p_lo2 <= v / 10 <= p_hi2)):
                    ctl_ok = False
                    break
            if ctl_ok:
                for ri, name in enumerate(row_names):
                    ys_r = sorted(rows_c[ri][0]["y2"] for rows_c in per_col)
                    row_y[name] = ys_r[len(ys_r) // 2]
                warnings.append("ROWS_FROM_VALUE_CLUSTERS(4)")
    if not (row_y["set"] < row_y["current"] < row_y["control"] < row_y["holding"]):
        warnings.append("ROW_ORDER_ABNORMAL")

    spacing = (col_x[drop] - col_x[zones[0]]) / len(zones)
    col_tol = min(layout["col_x_tolerance"], spacing / 2)
    row_tol = layout["row_y_tolerance"]
    g = min(row_y[b] - row_y[a] for a, b in zip(row_names, row_names[1:]))

    # 数据区 token：去斜后落在 (列头行, 保温行+tol] 内，排除列头与行标签结构 token
    # （HSV 设定行旁车 set_cell 不参与通用 band，只在设定行缺格时定点补充）
    # 083 S05：band 下界放宽到 holding + 1.75g（同 B&R 口径）——透视畸变使右侧
    # 各行 y2 随 x 下移可达约一个行距，右缘保温真值会被旧下界切掉，先收进来
    # 再按列对齐（温度计刻度等杂值由未分配罚吸收，不进单元格）。
    header_y = sum(t["y2"] for t in header_toks) / len(header_toks)
    struct_ids = {id(t) for t in header_toks + label_toks}
    band = [t for t in toks if header_y + 0.01 < t["y2"] <= row_y["holding"] + 1.75 * g
            and id(t) not in struct_ids and t.get("src") != "set_cell"]

    # 083 S05 逐列垂直对齐（同 B&R align_column 思路）：透视实拍右侧各行 y2
    # 随 x 整体下移，列头全局斜率 + 固定行位在右缘错行（Z025 后部控制值掉进
    # 保温行）。对每列在 o ∈ [-0.6g, 1.6g] 网格搜索垂直平移量，
    # 得分 = 归属距离和 + 未分配罚 + |o| 先验；正面图 o≈0 胜出，行为不变。
    # 行值域/形态硬约束（同 B&R）：控制行限百分比值域（含既有 /10 还原口径）；
    # 温度行限温度值域，裸整数（OCR 丢小数点 '280' 与温度计刻度 360/315- 同形）
    # 带 0.5*row_tol 形态罚分——只补空格，赢不了带小数点的真格；% 尾缀
    # （保温行低对比误读 '200%'）与 4 位无点还原形态（'2700'->270.0）不罚。
    t_lo, t_hi = rules["temperature_range_C"]
    p_lo, p_hi = rules["control_percent_range"]

    def _cell_eligible(t: dict, row: str) -> tuple[bool, float]:
        m = NUM_RE.search(t["text"])
        if not m:
            return False, 0.0
        raw = m.group()
        v = float(raw)
        if row == "control":
            ok = p_lo <= v <= p_hi or ("." not in raw and p_lo <= v / 10 <= p_hi)
            return ok, 0.0
        # 4 位无点 /10 还原形态（'2700'->270.0、'2801'->280.1）不罚
        if "." not in raw and len(raw) == 4 and t_lo <= v / 10 <= t_hi:
            return True, 0.0
        if not (t_lo <= v <= t_hi):
            return False, 0.0
        if "." in t["text"] or "%" in t["text"]:
            return True, 0.0
        return True, 0.5 * row_tol

    cells = {r: {} for r in row_names}
    for c in zones + [drop]:
        col_toks = [t for t in band if abs(t["x"] - col_x[c]) <= col_tol]
        if not col_toks:
            continue
        best = None
        o = -0.6 * g
        while o <= 1.6 * g + 1e-9:
            assigned: dict[str, tuple[float, dict]] = {}
            un = 0
            for t in col_toks:
                cands = [(n, _cell_eligible(t, n)[1]) for n in row_names
                         if _cell_eligible(t, n)[0]]
                if not cands:
                    un += 1
                    continue
                d, r = min((abs(t["y2"] - (row_y[n] + o)) + pen, n) for n, pen in cands)
                if d <= row_tol and r not in assigned:
                    assigned[r] = (d, t)
                else:
                    un += 1
            score = sum(d for d, _ in assigned.values()) + 0.5 * g * un + 0.05 * abs(o)
            if best is None or score < best[0] - 1e-9:
                best = (score, {r: t for r, (d, t) in assigned.items()})
            o += 0.05 * g
        for r, t in best[1].items():
            cells[r][c] = t
    # 行标签与首格合并的 token（标签文本内含数字）：数值归该行第一个空格
    for name, t in zip(row_names, label_toks):
        if not NUM_RE.search(t["text"]):
            continue
        for c in zones + [drop]:
            if c not in cells[name]:
                cells[name][c] = t
                break

    # 设定行 HSV 旁车补充（033）：基础/CLAHE 对红渐变框整行漏检时，用 set_cell
    # token 定点补设定行空格；仅数字形态 token、x 吸附列位、4 位无点按 /10 还原小数、
    # 值域护栏（料筒 [100,450]、落下口 [10,120]）防图形杂值误吸附
    sc = [t for t in toks if t.get("src") == "set_cell"]
    if sc and any(c not in cells["set"] for c in zones + [drop]):
        import re as _re
        numish = [t for t in sc
                  if _re.fullmatch(r"[\d.]+[%℃°Cc]*", t["text"].strip())
                  and sum(ch.isdigit() for ch in t["text"]) >= 2 and t["conf"] >= 0.6]
        if numish:
            if "set" in fallback_rows:
                row_y["set"] = sorted(t["y2"] for t in numish)[len(numish) // 2]
            for c in zones + [drop]:
                if c in cells["set"]:
                    continue
                near = [t for t in numish if abs(t["x"] - col_x[c]) <= col_tol]
                if not near:
                    continue
                t = min(near, key=lambda t: abs(t["x"] - col_x[c]))
                raw = NUM_RE.search(t["text"]).group()
                if "." not in raw and len(raw) == 4:
                    raw = raw[:3] + "." + raw[3]
                # 值域护栏：料筒设定 [100,450]，落下口设定 [10,120]，防图形杂值误吸附
                v = float(raw)
                lo, hi = (10.0, 120.0) if c == drop else (100.0, 450.0)
                if not (lo <= v <= hi):
                    continue
                cells["set"][c] = {**t, "text": raw, "_from": "set_cell"}
                warnings.append(f"SET_CELL_RESCUE({c})")

    def cell_number(row: str, col: str, lo: float, hi: float,
                    restored: list[str]) -> tuple[float | None, dict | None]:
        t = cells[row].get(col)
        if t is None:
            return None, None
        m = NUM_RE.search(t["text"])
        if not m:
            return None, t
        raw = m.group()
        if "." not in raw and len(raw) == 4:
            raw = raw[:3] + "." + raw[3]  # OCR 丢小数点（2718->271.8）
        v = float(raw)
        if "." not in raw and not (lo <= v <= hi) and lo <= v / 10 <= hi:
            # OCR 丢小数点且原值越界（550->55.0、415->41.5）：仅在 /10 后落回
            # 值域才还原，并留 DECIMAL_RESTORED 告警强制复核，不静默改值。
            restored.append(f"DECIMAL_RESTORED({row},{col}:{v}->{v / 10})")
            v = v / 10
        return v, t

    def row_values(row: str, cols_needed: list[str], lo: float, hi: float,
                   restored: list[str]) -> tuple[list[float | None], list[str]]:
        vals, ws = [], []
        for c in cols_needed:
            v, t = cell_number(row, c, lo, hi, restored)
            if v is None:
                ws.append(f"CELL_MISSING({row},{c})")
            elif t is not None and t["conf"] < rules["min_cell_conf"]:
                ws.append(f"LOW_CONF({row},{c},{t['conf']:.2f})")
            vals.append(v)
        return vals, ws

    t_rng = rules["temperature_range_C"]
    p_rng = rules["control_percent_range"]
    restored: list[str] = []
    setv, w1 = row_values("set", zones, *t_rng, restored)
    cur, w2 = row_values("current", zones, *t_rng, restored)
    ctl, w3 = row_values("control", zones, *p_rng, restored)
    hold, w4 = row_values("holding", zones, *t_rng, restored)
    drop_set, w5 = row_values("set", [drop], *t_rng, restored)
    drop_cur, w6 = row_values("current", [drop], *t_rng, restored)
    drop_ctl, w7 = row_values("control", [drop], *p_rng, restored)
    warnings.extend(w1 + w2 + w3 + w4 + w5 + w6 + w7)
    warnings.extend(restored)

    fields = {
        "barrel_temperature_set_c": setv,
        "barrel_temperature_current_c": cur,
        "control_percent": ctl,
        "holding_temperature_c": hold,
        "drop_port_temperature_set_c": drop_set[0],
        "drop_port_temperature_current_c": drop_cur[0],
        "drop_port_control_percent": drop_ctl[0],
    }

    # 范围校验
    t_lo, t_hi = rules["temperature_range_C"]
    p_lo, p_hi = rules["control_percent_range"]
    for name in ("barrel_temperature_set_c", "barrel_temperature_current_c",
                 "holding_temperature_c"):
        for i, v in enumerate(fields[name]):
            if v is not None and not (t_lo <= v <= t_hi):
                warnings.append(f"VALUE_OUT_OF_RANGE({name}[{i}]={v})")
    for name in ("drop_port_temperature_set_c", "drop_port_temperature_current_c"):
        v = fields[name]
        if v is not None and not (t_lo <= v <= t_hi):
            warnings.append(f"VALUE_OUT_OF_RANGE({name}={v})")
    for i, v in enumerate(fields["control_percent"]):
        if v is not None and not (p_lo <= v <= p_hi):
            warnings.append(f"VALUE_OUT_OF_RANGE(control_percent[{i}]={v})")
    v = fields["drop_port_control_percent"]
    if v is not None and not (p_lo <= v <= p_hi):
        warnings.append(f"VALUE_OUT_OF_RANGE(drop_port_control_percent={v})")

    # current vs set 一致性（±tol，超出 -> review；仅料筒段，落下口待机温差大不校验）
    tol_c = rules["current_set_consistency_tolerance_C"]
    for i, (cv, sv) in enumerate(zip(fields["barrel_temperature_current_c"],
                                     fields["barrel_temperature_set_c"])):
        if cv is not None and sv is not None and abs(cv - sv) > tol_c:
            warnings.append(f"CURRENT_SET_INCONSISTENT({zones[i]}: {cv} vs {sv})")

    detail = {
        "columns_measured": {lb: round(x, 4) for lb, x in col_x.items()},
        "row_centers": {r: round(row_y[r], 4) for r in row_names},
        "deskew_slope": round(k, 4),
        "cells": {r: {c: {"text": t["text"], "conf": round(t["conf"], 3)}
                      for c, t in cells[r].items()} for r in row_names},
    }
    return {"fields": fields, "heater_columns": len(zones),
            "warnings": warnings, "detail": detail}
