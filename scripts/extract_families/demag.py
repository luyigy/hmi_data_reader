"""DEMAG（德马格 Sumitomo SHI DEMAG NC 系列浅色 UI）温度页提取（026_PLAN S7 新增）。

布局（templates/demag.temperature.json）：屏幕列序 [喷嘴1,区3,区2,区1,料口]，
真值段序 = 屏幕序（用户 2026-08-01 核验裁定：区号从料口侧往喷嘴数，195°C 的区1 排最后），
料口=drop_port。
行 = 实际/设定/上偏差/下偏差（OCR 截字容忍，两个"差"行按 y 序分上下）；
control 取列顶蓝框整数（表内速率行恒 0 不取，料口可为负值=冷却）；
左下油块=油温实际/设定；保温=holding。返回结构同 extract_families.keba。
"""
import re

from .common import _affine_fit_columns, _anchor_match, _fit_slope, _num  # noqa: F401

RATE_RE = re.compile(r"-?\d+\.?\d*")


def _rate_num(t):
    m = RATE_RE.search(t["text"])
    return float(m.group()) if m else None

PHYSICAL = [0, 1, 2, 3]  # 段序 = 屏幕序 [喷嘴1,区3,区2,区1]（用户 2026-08-01 核验裁定：区号从料口侧往喷嘴数）
COL_NAMES = ["喷嘴1", "区3", "区2", "区1", "料口"]


def _val(t):
    return _num(t)


def _band_nums(toks, y, k, x_lo=0.08, x_hi=0.95, tol=0.02, min_v=None,
               max_v=None, span_centers=None):
    out = []
    for t in toks:
        v = _val(t)
        if v is None:
            continue
        if abs(t["y"] - (y + k * (t["x"] - 0.5))) < tol and x_lo < t["x"] < x_hi:
            if min_v is not None and v < min_v:
                continue
            # 083 S07：列检测带加双护栏——超温度量程的粘连合并 token
            # （'300290280'）与横向覆盖 ≥2 模板列中心的合并 token 都不是
            # 单格值，不得成为幻影列（同 S06 速率行防护口径）。
            if max_v is not None and v > max_v:
                continue
            if span_centers is not None:
                x0 = t.get("x0", t["x"])
                x1 = t.get("x1", t["x"])
                if sum(1 for cx in span_centers if x0 < cx < x1) >= 2:
                    continue
            out.append((t["x"], v, t))
    return sorted(out, key=lambda e: e[0])


def _dedupe_x(vals, gap=0.025):
    out = []
    for e in vals:
        if out and abs(e[0] - out[-1][0]) < gap:
            if e[2]["conf"] > out[-1][2]["conf"]:
                out[-1] = e
        else:
            out.append(e)
    return out


def extract_temperature_demag(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    anchors = template["row_anchors"]
    rules = template["validation_rules"]

    def find_label(keys, xmax=0.2, y_lo=0.3, y_hi=0.65):
        cands = [t for t in toks if t["x"] < xmax and y_lo < t["y"] < y_hi
                 and _anchor_match(keys, t["text"])]
        return min(cands, key=lambda t: t["y"]) if cands else None

    cur_lab = find_label(anchors["current"])
    set_lab = find_label(anchors["set"])
    # 两个"差"行按 y 序分上下
    devs = sorted([t for t in toks if t["x"] < 0.2 and 0.35 < t["y"] < 0.65
                   and _anchor_match(anchors["high_low_generic"], t["text"])],
                  key=lambda t: t["y"])
    if not (cur_lab and set_lab) or len(devs) < 2:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["ROW_ANCHORS_NOT_FOUND"], "detail": {}}
    high_lab, low_lab = devs[0], devs[1]
    if low_lab["y"] - high_lab["y"] < 0.015:
        # 两个"差"行标签塌缩到同一 y（OCR 截字）：按模板行距展开，防上行值串入下行
        low_lab = {**low_lab, "y": high_lab["y"] + 0.036}
        warnings.append("DEV_ROWS_COLLAPSED_EXPANDED")

    # 去斜：实际行数值拟合
    cur_nums = [t for t in toks if _num(t) is not None and t["x"] > 0.08
                and abs(t["y"] - cur_lab["y"]) < 0.02]
    k = _fit_slope(cur_nums)
    # 083 S11：料口列格子整列下沉（漏斗位）时其设定行值会混入实际行带
    # （实测 Z005 rank29：料口设定 50 混入 cur_nums），4 点最小二乘被该
    # 离群点翻转斜率符号（k=+0.025，真实 -0.040），设定/偏差行带右半
    # 整体错位取到上偏差值。残差超半行带容差（0.01）的最坏点剔除后
    # 重拟合一次；_fit_slope 共享助手不动，其他家族不受影响。
    if len(cur_nums) >= 4:
        mx = sum(t["x"] for t in cur_nums) / len(cur_nums)
        c0 = sum(t["y"] for t in cur_nums) / len(cur_nums) - k * (mx - 0.5)
        worst = max(cur_nums,
                    key=lambda t: abs(t["y"] - (k * (t["x"] - 0.5) + c0)))
        if abs(worst["y"] - (k * (worst["x"] - 0.5) + c0)) > 0.01:
            k = _fit_slope([t for t in cur_nums if t is not worst])

    # 列位：实际行数值 x（去重保高置信），期望 5 列
    tpl_cols = template["layout_hint"]["column_x_centers"]
    tpl_x = [tpl_cols[n] for n in COL_NAMES]
    cols = _dedupe_x(_band_nums(toks, cur_lab["y"], k, min_v=10.0,
                                max_v=rules["temperature_range_C"][1],
                                span_centers=tpl_x))

    def _header_anchors():
        """实测列 -> 模板列名锚定（083 S07）：列头 token（含模板登记的 OCR
        误读变体）与实测列 x 对齐，仅取实际行上方的列头。"""
        variants = template.get("column_header_variants") or {}
        anchors = {}
        for i, e in enumerate(cols):
            best = None
            for t in toks:
                if t["y"] >= cur_lab["y"]:
                    continue
                for name in COL_NAMES:
                    cands = variants.get(name) or ([name[:-1]] if name == "喷嘴1" else [name])
                    if any(c in t["text"] for c in cands):
                        d = abs(t["x"] - e[0])
                        if d < 0.04 and (best is None or d < best[0]):
                            best = (d, name)
                        break
            if best:
                anchors[i] = best[1]
        return anchors

    if len(cols) >= 5:
        while len(cols) > 5:
            cols.remove(min(cols, key=lambda e: e[2]["conf"]))
        col_x = [e[0] for e in cols]
    elif len(cols) in (3, 4) and (hdr_anchors := _header_anchors()) and (
            fit := _affine_fit_columns([e[0] for e in cols], tpl_x, 0.2,
                                       hdr_anchors=hdr_anchors,
                                       labels_all=COL_NAMES)) is not None:
        # 083 S07：缺列（蓝底高亮选中列整列漏读）时优先列头锚定的有序仿射
        # 配准（复用 S05 B&R 共享助手，残差≤0.02 硬约束）——模板注明喷嘴1
        # 列位随透视漂移 0.15~0.34，贪心最近邻在缺首列时会整列错位。
        col_x, miss_idx = fit
        missing = [COL_NAMES[j] for j in miss_idx]
        warnings.append(f"COLUMN_MISSING({','.join(missing)})")
        warnings.append(f"COLUMN_AFFINE_FIT(missing={','.join(missing)})")
    elif len(cols) == 4:
        # 缺一列：与模板列位比对，按最近邻把 4 个实测分配给 5 个模板列
        col_x = list(tpl_x)
        assigned = set()
        for e in cols:
            j = min((j for j in range(5) if j not in assigned),
                    key=lambda j: abs(e[0] - tpl_x[j]))
            col_x[j] = e[0]
            assigned.add(j)
        missing = [COL_NAMES[j] for j in range(5) if j not in assigned]
        warnings.append(f"COLUMN_MISSING({','.join(missing)})")
    else:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"COLUMNS_NOT_FOUND({len(cols)}/5)"], "detail": {}}

    def row_at(y, min_v=None, y_off=0.0, tol=0.02, report_missing=True,
               v_range=None):
        """按列位从行 y（+偏移）的 band 里取 5 列值（最近邻，容差 tol）。
        y_off 用于 OCR 行标签与数值格纵向错位（标签在格子上沿）的行。
        083 S03：v_range 给定时的取值顺序——值域内主 OCR 最近邻优先，其次
        值域内逐格重读旁车（src=demag_cell），最后才回落任意主 OCR token
        （保留 VALUE_OUT_OF_RANGE 门禁证据）；竖向粘连的多格合并 token
        （'505010'/'3023030'）因此不再抢占单格重读的正确值。"""
        band = [e for e in _band_nums(toks, y + y_off, k, min_v=min_v, tol=tol)]
        lo, hi = v_range if v_range else (None, None)

        def pick(entries):
            return min(entries, key=lambda e: abs(e[0] - cx))[1]

        vals = []
        for i, cx in enumerate(col_x):
            near = [e for e in band if abs(e[0] - cx) < 0.045]
            base = [e for e in near if e[2].get("src") != "demag_cell"]
            cells = [e for e in near if e[2].get("src") == "demag_cell"]
            v = None
            if lo is not None:
                in_range = [e for e in base if lo <= e[1] <= hi]
                if in_range:
                    v = pick(in_range)
                else:
                    cell_in_range = [e for e in cells if lo <= e[1] <= hi]
                    if cell_in_range:
                        v = pick(cell_in_range)
                    elif base:
                        v = pick(base)
                    elif cells:
                        v = pick(cells)
            elif near:
                v = pick(near)
            if v is None:
                vals.append(None)
                if report_missing:
                    warnings.append(f"CELL_MISSING({COL_NAMES[i]})")
            else:
                vals.append(v)
        return vals

    t_rng = rules["temperature_range_C"]
    d_rng = rules["deviation_range_C"]
    cur5 = row_at(cur_lab["y"], min_v=10.0, v_range=t_rng)
    set5 = row_at(set_lab["y"], min_v=10.0, v_range=t_rng)

    # 偏差两行：标签与数值纵向错位不稳定，改为值域聚类——设定行下方全 ≤60 的
    # 数值簇（速率行恒 0 为第三簇不取），按 y 序定上/下偏差（行值域硬约束先例）
    def dev_rows():
        region = []
        for t in toks:
            v = _num(t)
            # 083 S03：竖向粘连的多格合并 token（'3023030' 等）值远超偏差/速率
            # 量程，进 region 会污染值域聚类（all(v<=60) 整簇作废），直接排除
            if v is None or v > 100 or not (0.08 < t["x"] < 0.95
                                            and set_lab["y"] + 0.005 < t["y"] < 0.62):
                continue
            region.append({"x": t["x"], "y": t["y"], "v": v, "src": t.get("src")})
        if len(region) < 8:
            return None
        k2 = _fit_slope(region) if len(region) >= 3 else 0.0
        for e in region:
            e["yc"] = e["y"] - k2 * (e["x"] - 0.5)
        region.sort(key=lambda e: (e["yc"], e["x"]))
        clusters = []
        for e in region:
            if clusters and e["yc"] - clusters[-1][-1]["yc"] <= 0.018:
                clusters[-1].append(e)
            else:
                clusters.append([e])
        dev_c = [c for c in clusters if len(c) >= 4 and all(e["v"] <= 60 for e in c)]
        if len(dev_c) < 2:
            return None
        dev_c.sort(key=lambda c: sum(e["yc"] for e in c) / len(c))
        return dev_c[0], dev_c[1]

    def row_from_cluster(c, row_name):
        vals = []
        for i, cx in enumerate(col_x):
            near = [e for e in c if abs(e["x"] - cx) < 0.045]
            if near:
                # 同格主 OCR 与逐格重读旁车并存时主 OCR 优先（033 修复3 口径）
                base = [e for e in near if e.get("src") != "demag_cell"]
                vals.append(min(base or near, key=lambda e: abs(e["x"] - cx))["v"])
            else:
                vals.append(None)
        return vals

    dr = dev_rows()

    def best_dev_row(lab_y):
        """两种窗口几何（标签与数值对齐 / 数值在标签下 ~0.015）择优；并列取偏移版。
        083 S10：越界取值与缺格同计坏格——竖向粘连合并 token（'2020' 占两格）只
        落在偏移窗内，若按缺格数并列取偏移版，合并值会挤掉主窗内值域合法的逐格
        重读值（row_at 值域内旁车优先口径因此失效）。"""
        a = row_at(lab_y, report_missing=False, v_range=d_rng)
        b = row_at(lab_y, y_off=0.015, tol=0.013, report_missing=False, v_range=d_rng)

        def bad(vals):
            return sum(v is None or not (d_rng[0] <= v <= d_rng[1]) for v in vals)

        return b if bad(b) <= bad(a) else a

    high5 = best_dev_row(high_lab["y"])
    low5 = best_dev_row(low_lab["y"])
    if dr:
        if sum(v is None for v in high5) >= 2:
            high5 = row_from_cluster(dr[0], "high")
        if sum(v is None for v in low5) >= 2:
            low5 = row_from_cluster(dr[1], "low")
    for row_name, values in (("high", high5), ("low", low5)):
        for i, value in enumerate(values):
            if value is None:
                warnings.append(f"CELL_MISSING({COL_NAMES[i]},{row_name})")

    # control：列顶蓝框（列标签上方整数 token，允许负值；基础/CLAHE 漏检由 .ocr_rates 旁车补充）
    hdr = [t for t in toks if _anchor_match(anchors["column_headers"], t["text"])]
    hdr_y = min((t["y"] for t in hdr), default=cur_lab["y"] - 0.04)

    def _spans_multi_col(t):
        # 083 S06：横向跨列合并 token（如 '111239' 覆盖 区3/区2/区1 三列中心）
        # 不得参与单列取值——位数优先会误选合并值抢占单格重读的正确值；
        # 排除后由 rate_cell 旁车取值或 RATE_MISSING 兜底（宁缺不错）。
        x0 = t.get("x0", t["x"])
        x1 = t.get("x1", t["x"])
        return sum(1 for cx in col_x if x0 < cx < x1) >= 2

    top = [t for t in toks if hdr_y - 0.22 < t["y"] < hdr_y - 0.005
           and RATE_RE.search(t["text"]) and t["conf"] >= 0.6
           and not _spans_multi_col(t)]
    ctl5 = []
    for i, cx in enumerate(col_x):
        near = [t for t in top if abs(t["x"] - cx) < 0.05]
        if near:
            # 宁缺不错：优先 HSV 单格源（位置精确），再位数多（防 '17'->'1' 截读）、
            # 再高置信、x 最近
            best = min(near, key=lambda t: (-len(RATE_RE.search(t["text"]).group().lstrip("-").split(".")[0]),
                                            t.get("src") != "rate_cell",
                                            -t["conf"], abs(t["x"] - cx)))
            ctl5.append(_rate_num(best))
        else:
            ctl5.append(None)
            warnings.append(f"RATE_MISSING({COL_NAMES[i]})")

    # 油块（左下 y>0.6）：实际/设定 标签同行的值（候选按置信度取，防 CLAHE 残字干扰）
    # 083 S10：实拍竖构图油块可下沉到 y≈0.85（实测 Z002 rank12 标签 0.806/0.851
    # 超出 0.8 窗口整组缺读），窗口下沿放宽到 0.9；该区域仅油块含 实际/设定
    # 行标签，主表行标签在 y<0.6 不受影响。
    def oil_val(key):
        lab = find_label(anchors[key], xmax=0.25, y_lo=0.6, y_hi=0.9)
        if not lab:
            # 行标签截字兜底：放宽为只含「实际」/「设定」的 token
            fallback = "实际" if "current" in key else "设定"
            lab = find_label(fallback, xmax=0.25, y_lo=0.6, y_hi=0.9)
        if not lab:
            return None
        band = [t for t in toks if abs(t["y"] - lab["y"]) < 0.02
                and lab["x"] < t["x"] < lab["x"] + 0.2 and _num(t) is not None]
        if not band:
            return None
        # 防 CLAHE 残字（'24'->'2'）：位数多者优先，再取高置信
        best = max(band, key=lambda t: (len(re.sub(r"\D", "", t["text"])), t["conf"]))
        return _num(best)

    oil_cur = oil_val("oil_current")
    oil_set = oil_val("oil_set")
    if oil_cur is None:
        warnings.append("OIL_CURRENT_NOT_FOUND")
    if oil_set is None:
        warnings.append("OIL_SET_NOT_FOUND")

    # 保温
    holding = None
    hlab = [t for t in toks if _anchor_match(anchors["holding"], t["text"])]
    if hlab:
        h = hlab[0]
        lo, hi = rules["holding_range_C"]
        cand = [t for t in toks if abs(t["y"] - h["y"]) < 0.06 and t["x"] > h["x"]
                and _num(t) is not None and lo <= _num(t) <= hi]
        if cand:
            holding = _num(min(cand, key=lambda t: (abs(t["y"] - h["y"]), t["x"])))
    if holding is None:
        warnings.append("HOLDING_NOT_FOUND")

    def gate5(vals, range_key, row_name):
        lo, hi = rules[range_key]
        out = []
        for i, v in enumerate(vals):
            if v is None:
                out.append(None)
            elif lo <= v <= hi:
                out.append(v)
            else:
                out.append(None)
                warnings.append(f"VALUE_OUT_OF_RANGE({row_name},{COL_NAMES[i]},{v})")
        return out

    cur_g = gate5(cur5, "temperature_range_C", "current")
    set_g = gate5(set5, "temperature_range_C", "set")
    high_g = gate5(high5, "deviation_range_C", "high")
    low_g = gate5(low5, "deviation_range_C", "low")
    ctl_g = gate5(ctl5, "control_range_pct", "control")

    def phys(vals):
        return [vals[i] for i in PHYSICAL]

    fields = {
        "barrel_temperature_current_c": phys(cur_g),
        "barrel_temperature_set_c": phys(set_g),
        "high_deviation_c": phys(high_g),
        "low_deviation_c": phys(low_g),
        "control_percent": phys(ctl_g),
        "drop_port_temperature_current_c": cur_g[4],
        "drop_port_temperature_set_c": set_g[4],
        "drop_port_control_percent": ctl_g[4],
        "oil_temperature_current_c": oil_cur,
        "oil_temperature_set_c": oil_set,
        "holding_temperature_c": holding,
    }
    detail = {
        "row_y": {"current": round(cur_lab["y"], 4), "set": round(set_lab["y"], 4),
                  "high": round(high_lab["y"], 4), "low": round(low_lab["y"], 4)},
        "deskew_slope": round(k, 4),
        "col_x_screen_order": [round(x, 4) for x in col_x],
        "screen_rows": {"current": cur5, "set": set5, "high": high5, "low": low5,
                        "rate_top": ctl5},
    }
    return {"fields": fields, "heater_columns": 4, "warnings": warnings, "detail": detail}
