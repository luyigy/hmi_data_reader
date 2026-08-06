"""DEMAG 射出/保压页提取（035_PLAN 第二波新增，双变体）。

- 多级注射曲线页（026_FIX 领域确认语义）：右侧段表上 row=各段射胶速度 mm/s、
  下 row=各段起点位置 mm（本页无分段压力）；左列 压力/速度/位置 =
  保压压力/保压速度/V-P 切换位置；右上为全局射胶压力上限（全段通用）。
- 工艺优化页：按模板 (row_y, col_x) 网格取设定值（左灰框，右蓝框为实际值不取）。
返回结构同 keba。
"""
import re

from .common import _anchor_match, _fit_slope, _num  # noqa: F401

NUM_RE = re.compile(r"\d+\.?\d*")

# Layer 1 禁用段图像观测：深色背景格亮度 / 段表白格基线 的判定阈值。
# 标定（2026-08-05，inj_z002_calib rank01 + ground_truth/demag_holding 5 张真值图）：
# 深色禁用格比值 ∈ [0.44, 0.65]，启用格 ∈ [0.86, 1.05]，取两者中点 0.75。
DARK_CELL_RATIO = 0.75


def _cell_brightness(img, cells: list[tuple[float, float]]) -> list[float]:
    """按归一化中心采样段表格亮度中位数。采样窗宽=相邻格 x 最小间距*0.9
    （单格缺省 0.05），窗高≈行距一半（0.036，段表行距实测约 0.037）。"""
    import numpy as np

    h, w = img.shape[:2]
    xs = [x for x, _ in cells]
    gaps = [b - a for a, b in zip(xs, xs[1:])]
    gap = min(gaps) if gaps else 0.05
    hw, hh = gap * 0.45, 0.018
    meds = []
    for x, y in cells:
        px, py = int(x * w), int(y * h)
        dx, dy = int(hw * w), int(hh * h)
        patch = img[max(0, py - dy):py + dy, max(0, px - dx):px + dx]
        meds.append(float(np.median(patch)) if patch.size else 0.0)
    return meds


def _stage_enabled(img, captures: dict[str, list[tuple[float, float]]]) -> dict[str, list[bool]]:
    """captures: {field_key: [(x, y), ...]}（屏幕序，剔除/反转前的捕获集合）
    -> {field_key: [bool, ...]}（True=启用亮格，False=深色禁用格）。
    基线=全部段表格亮度中位数的 75 分位（白色单元），低于 DARK_CELL_RATIO*基线 判深色。"""
    import numpy as np

    meds = {k: _cell_brightness(img, cells) for k, cells in captures.items() if cells}
    all_meds = [m for ms in meds.values() for m in ms]
    if not all_meds:
        return {}
    baseline = float(np.percentile(all_meds, 75))
    if baseline <= 0:
        return {}
    return {k: [m >= DARK_CELL_RATIO * baseline for m in ms] for k, ms in meds.items()}


def _v(text):
    m = NUM_RE.search(text)
    return float(m.group()) if m else None


def _pressure_unit_text(label: str | None) -> str | None:
    """压力行标签原文中的单位字符串：含 bar_spez（塑料压力）/"[bar]"，未标出为 None。"""
    if not label:
        return None
    if "bar_spez" in label:
        return "bar_spez"
    if "[bar]" in label:
        return "bar"
    return None


def _is_curve(toks):
    keys = ["多级注", "注射常数", "移动曲线", "多级", "多段"]
    return any(_anchor_match(keys, t["text"]) for t in toks)


def _v_range(text: str, lo: float, hi: float) -> float | None:
    """范围感知取值：普通匹配 → 小数形态 → 无点数字串补点（设定/实际粘连：
    '14001400'->14.0、'950853'->95.0、'72.040.1'->72.0）。"""
    cands = []
    m = NUM_RE.search(text)
    if m:
        cands.append(float(m.group()))
    cands += [float(x) for x in re.findall(r"\d{2,3}\.\d", text)]
    digits = re.sub(r"\D", "", text)
    for i in (2, 3):
        if len(digits) > i:
            cands.append(float(digits[:i] + "." + digits[i]))
    for v in cands:
        if lo <= v <= hi:
            return v
    return None


def _page_value_offset(toks, rows, keys=("pressure", "velocity", "position"), half=0.012):
    """估计整页数值行相对行标签的纵向偏移（029_FIX）。
    DEMAG NC 段表在部分拍照几何下"标签在行底、数值在其上方约 0.023"，而同 y 布局
    偏移为 0；固定容差带无法同时兼容（带大则吃进相邻行，带小则漏值）。
    做法：为每行收集标签上方的数值聚类中心作为候选偏移（含 0），
    取三行总捕获单元数最多的偏移；调用方以 row_y+offset 为数值行、±half 取值。"""
    num = re.compile(r"\d+\.?\d*")

    def capture(offset):
        total = 0
        for key in keys:
            ly = rows[key] + offset
            total += sum(1 for t in toks
                         if num.fullmatch(t["text"].strip())
                         and abs(t["y"] - ly) <= half)
        return total

    candidates = {0.0}
    for key in keys:
        ly = rows[key]
        above = sorted(t["y"] for t in toks
                       if num.fullmatch(t["text"].strip())
                       and 0.005 < ly - t["y"] <= 0.045)
        clusters, cur = [], []
        for y in above:
            if cur and y - cur[-1] > 0.015:
                clusters.append(cur)
                cur = []
            cur.append(y)
        if cur:
            clusters.append(cur)
        for cluster in clusters:
            candidates.add(round(sum(cluster) / len(cluster) - ly, 4))
    return max(candidates, key=capture)


def _extract_global_pressure(toks, pressure_row_y, tpl, warnings):
    """右上全局射胶压力上限（026_FIX 新增锚区）：x > x_min 且位于段表上 row
    上方 dy_above 带内的数值（带下限可为小幅负值：拍照矫正后该值可能与压力行同 y）；
    取最贴近段表者。找不到返回 None 并告警，不猜。"""
    spec = tpl.get("global_pressure") or {}
    x_min = spec.get("x_min", 0.75)
    dy_lo, dy_hi = spec.get("dy_above", [-0.005, 0.08])
    cands = [(t["y"], t["x"], _v(t["text"]), t.get("src") == "ocr_variant") for t in toks
             if t["x"] > x_min
             and pressure_row_y - dy_hi <= t["y"] <= pressure_row_y - dy_lo
             and re.fullmatch(r"\d+\.?\d*", t["text"].strip())]
    cands = [c for c in cands if c[2] is not None]
    if not cands:
        warnings.append("CELL_MISSING(injection_pressure_limit_bar)")
        return None
    # 034_FIX：锚带下沿与段表上 row 相邻，变体补回的段值 token 会落入带内
    # （rank05 '30.0' 盖过 '110.0' 实测）——与主 OCR 候选并存时主值优先，
    # 变体仅在主 OCR 整带漏检时兜底（同 033_FIX 修复3 口径）。
    main = [c for c in cands if not c[3]]
    if main:
        cands = main
    cands.sort(key=lambda c: (c[0], c[1]))
    return cands[-1][2]


def _extract_curve(toks, tpl, warnings, img=None):
    top_texts = [t["text"] for t in toks if t.get("y", 0) < 0.85]
    has_holding = any(_anchor_match(["多级保压", "保压段"], t) for t in top_texts)
    if not has_holding:
        # 035 保压真值（app 反馈 e3ebbba2）补充指纹：标题在裁切拍照中可能完全缺席，
        # 改用结构性锚词——段表区（y>0.5、左半区）的"时间[s]"行标签（多级注射页
        # 该位置为"位置[mm]"行，其"注射时间"在左列 y<0.5，不会误中），
        # 或左列实际值区的"实际切换"标题（注射页左列为 注射时间/注射压力/位置/余料量）。
        has_holding = any(
            _anchor_match(["时间[s]", "时间]"], t["text"])
            and t.get("y", 0) > 0.5 and t.get("x", 1) < 0.45
            for t in toks
        ) or any(_anchor_match(["实际切换"], t["text"]) for t in toks)
    has_backp = any(_anchor_match(["多级背压", "背压[bar]", "螺杆转速"], t) for t in top_texts)

    ra = {
        "pressure": ["压力[bar]", "压力", "背压[bar]", "背压"],
        "velocity": ["速度[mm/s]", "速度", "螺杆转速", "速度[mms]"],
        "position": ["位置[mm]", "位置", "时间]", "时间"],
    }
    hint = tpl.get("row_y_hint", {"pressure": 0.68, "velocity": 0.72, "position": 0.75})
    rows = {}
    pressure_label = None  # 压力行标签原文（注射/保压变体压力侧别观测用）
    anchor_missing = []  # 033_FIX 修复1：逐行记录锚词是否命中（背压变体不动）
    for key, keys in ra.items():
        # 行标签只在左侧标签区（x<0.45）出现；右下"多级速度"勾选框等同名
        # 复选框在部分几何下比真行更靠近 hint，会抢占锚定（030_FIX 图 5 实测）。
        hits = [t for t in toks if t["x"] < 0.45 and _anchor_match(keys, t["text"])]
        anchor = min(hits, key=lambda t: abs(t["y"] - hint[key])) if hits else None
        rows[key] = anchor["y"] if anchor else hint[key]
        if anchor is None:
            anchor_missing.append(key)
        if key == "pressure" and anchor is not None:
            pressure_label = anchor["text"]
    if anchor_missing and not has_backp:
        # 033_FIX 修复1：关键行锚词缺失时 hint 兜底猜到的可能是错行的值且
        # status=ok（cac666e7 左裁切实测行互换仍 ok）——诚实降级，宁可拒不可错。
        for key in anchor_missing:
            warnings.append(f"ROW_ANCHOR_MISSING({key})")

    dy = _page_value_offset([t for t in toks if t["x"] > 0.45], rows)
    vrow = {key: rows[key] + dy for key in rows}
    _half = 0.012
    # 030_FIX：偏移数值行只用于已验证变体（注射/保压）；背压等未验证变体
    # 的共享路径保持 029 前行为（rows 行 ±0.025），不被偏移逻辑改写。
    _row_of = (lambda key: vrow[key]) if not has_backp else (lambda key: rows[key])
    _tol = _half if not has_backp else 0.025

    out = {}
    for key in ("pressure", "velocity", "position"):
        ly = rows[key]
        cands = sorted(((t["x"], _v(t["text"])) for t in toks
                        if abs(t["y"] - ly) <= 0.025 and 0.12 < t["x"] < 0.45
                        and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                       key=lambda e: e[0])
        out[key] = [v for _, v in cands if v is not None]

    # 多段表格抽取逻辑（右侧 x > 0.45）：
    # 模式 1：同行布局（多级保压 / 多级背压页：阶段压力在 rows['pressure']，阶段速度在 rows['velocity']；
    # 多级注射页 026_FIX：rows['pressure'] 行=段速度上 row，rows['velocity'] 行=段位置下 row）
    def _var(t):
        # 033_FIX 修复3：CLAHE 合并追加（ocr_variant）与段网格旁车（slot）
        # token 属变体来源，同格冲突时主 OCR 值优先。
        return bool(t.get("slot")) or t.get("src") == "ocr_variant"

    sp_same = sorted(((t["x"], _v(t["text"]), _var(t)) for t in toks
                      if abs(t["y"] - _row_of("pressure")) <= _tol and t["x"] > 0.45
                      and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                     key=lambda e: e[0])
    sv_same = sorted(((t["x"], _v(t["text"]), _var(t)) for t in toks
                      if abs(t["y"] - _row_of("velocity")) <= _tol and t["x"] > 0.45
                      and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                     key=lambda e: e[0])

    # 模式 2：DEMAG 多级注射页错行布局（段表整体下移一行：上 row 位于 rows['velocity']，
    # 下 row 位于 rows['position']；026_FIX：上 row=段速度、下 row=段位置）
    sp_inj = sorted(((t["x"], _v(t["text"]), _var(t)) for t in toks
                     if abs(t["y"] - _row_of("velocity")) <= _tol and t["x"] > 0.60
                     and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                    key=lambda e: e[0])
    sv_inj = sorted(((t["x"], _v(t["text"]), _var(t)) for t in toks
                     if abs(t["y"] - _row_of("position")) <= _tol and t["x"] > 0.60
                     and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                    key=lambda e: e[0])

    def _dedupe(arr):
        # 033_FIX 修复3：同格（x 间距 <0.018）异值冲突时优先主 OCR 变体的值
        # （rank02 段网格旁车 '004500' 盖住主 OCR '45.00' 实测）；冲突双方
        # 无主从之分时保持原行为（间距 >0.01 且异值两个都留）。
        arr = [item for item in arr if item[1] is not None]
        deduped = []
        for item in arr:
            if not deduped or (item[0] - deduped[-1][0] >= 0.018):
                deduped.append(item)
            elif item[1] != deduped[-1][1]:
                last = deduped[-1]
                if last[2] and not item[2]:
                    deduped[-1] = item  # 变体在前、主 token 在后：替换
                elif item[2] and not last[2]:
                    pass  # 主 token 在前：丢弃变体
                elif item[0] - last[0] > 0.01:
                    deduped.append(item)
        return deduped

    sp_same, sv_same = _dedupe(sp_same), _dedupe(sv_same)
    sp_inj, sv_inj = _dedupe(sp_inj), _dedupe(sv_inj)

    cap_rows = None  # 注射变体捕获行的实际 y（Layer 1 图像观测采样用）
    if has_backp:
        variant = "multi_stage_back_pressure"
        pressure = sp_same
        velocity = sv_same
    elif has_holding:
        variant = "multi_stage_holding"
        pressure = sp_same
        velocity = sv_same
    elif len(sp_same) >= 2 and len(sv_same) >= 2:
        variant = "multi_stage_injection"
        pressure = sp_same
        velocity = sv_same
        cap_rows = (_row_of("pressure"), _row_of("velocity"))
    elif len(sp_inj) >= 2 and len(sv_inj) >= 2:
        variant = "multi_stage_injection"
        pressure = sp_inj
        velocity = sv_inj
        cap_rows = (_row_of("velocity"), _row_of("position"))
    else:
        variant = "multi_stage_injection"
        pressure = sp_same if sp_same else sp_inj
        velocity = sv_same if sv_same else sv_inj
        cap_rows = (_row_of("pressure") if pressure is sp_same else _row_of("velocity"),
                    _row_of("velocity") if velocity is sv_same else _row_of("position"))

    time_cells = []

    sp_list = [v for _, v, _ in pressure]
    sv_list = [v for _, v, _ in velocity]
    fields = {}

    if variant == "multi_stage_holding":
        # 035 保压真值（app 反馈 e3ebbba2，领域确认）：段表 压力[bar] 行=各段保压压力、
        # 时间[s] 行=各段保压时长（segment_duration），速度[mm/s] 行=全局保压速度设定；
        # 左列为实际值（实际切换/保压/位置/余料量）不入字段。屏幕自右向左为第 1 段起，
        # 在输出边界统一反转为物理段序并剔除最左未启用的 0 值段槽位（深灰框）。
        # 注射页字段（pressure_limit_bar/first_*/stage_pressure_bar/stage_velocity_mms 等）
        # 在本页为误标，一律不输出；找不到的行给 None/空数组 + CELL_MISSING，不猜。
        time_cells = _dedupe(sorted(
            ((t["x"], _v(t["text"]), _var(t)) for t in toks
             if abs(t["y"] - _row_of("position")) <= _tol and t["x"] > 0.45
             and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
            key=lambda e: e[0]))
        time_list = [v for _, v, _ in time_cells]
        fields["stage_holding_pressure_bar"] = sp_list
        fields["stage_holding_time_s"] = time_list
        # 030_FIX（领域确认）：DEMAG 保压页速度行是**分段**字段（如 15/10/5），
        # 仅本 profile 按分段输出；单个有效值的页面经反转块回退为 holding_velocity_mms
        # 单值。其他家族保压速度为全局单值的语义不写死在这里。
        fields["stage_holding_velocity_mms"] = sv_list
        if not sp_list:
            warnings.append("CELL_MISSING(stage_holding_pressure_bar)")
        if not time_list:
            warnings.append("CELL_MISSING(stage_holding_time_s)")
        if not sv_list:
            warnings.append("CELL_MISSING(stage_holding_velocity_mms)")
    elif variant == "multi_stage_back_pressure":
        table_toks = [t for t in toks if 0.55 < t.get("y", 0) < 0.85]

        def _find_row_y(keys, default_y):
            hits = [t["y"] for t in table_toks if _anchor_match(keys, t["text"])]
            return min(hits, key=lambda y: abs(y - default_y)) if hits else default_y

        r_bp = _find_row_y(["背压[bar]", "背压"], 0.628)
        r_rpm = _find_row_y(["螺杆转速[U/rnin]", "螺杆转速", "转速"], 0.668)
        r_pos = _find_row_y(["位置[mm]", "位置"], 0.708)
        r_spd = _find_row_y(["速度[mm/s]", "速度"], 0.746)

        def _get_row_vals(ly, min_x=0.40):
            cands = sorted([(t["x"], _v(t["text"])) for t in table_toks
                            if abs(t["y"] - ly) <= 0.02 and t["x"] > min_x
                            and re.fullmatch(r"\d+\.?\d*", t["text"].strip())],
                           key=lambda e: e[0])
            deduped = []
            for item in cands:
                if not deduped or (item[0] - deduped[-1][0] >= 0.018):
                    deduped.append(item)
                elif item[1] != deduped[-1][1] and item[0] - deduped[-1][0] > 0.01:
                    deduped.append(item)
            return [v for _, v in deduped]

        bp_vals = _get_row_vals(r_bp, min_x=0.45)
        rpm_vals = _get_row_vals(r_rpm, min_x=0.45)
        pos_vals = _get_row_vals(r_pos, min_x=0.40)
        spd_vals = _get_row_vals(r_spd, min_x=0.40)

        fields["stage_back_pressure_bar"] = bp_vals
        fields["stage_plasticizing_speed_rpm"] = rpm_vals
        fields["stage_position_mm"] = pos_vals
        fields["stage_velocity_mms"] = spd_vals
        fields["first_velocity_mms"] = spd_vals[0] if spd_vals else (out["velocity"][0] if out["velocity"] else None)
        fields["first_position_mm"] = pos_vals[0] if pos_vals else (out["position"][0] if out["position"] else None)
        fields["pressure_limit_bar"] = None
        fields["stage_pressure_bar"] = bp_vals
    else:  # multi_stage_injection
        # 026_FIX（领域确认）：段表上 row（rows['pressure'] 行）= 各段射胶速度 mm/s，
        # 下 row（rows['velocity'] 行）= 各段起点位置 mm；本页无分段压力，不再输出
        # stage_pressure_bar。左列 压力/速度/位置 = 保压压力/保压速度/V-P 切换位置
        # （非首段设定值，废止 pressure_limit_bar/first_velocity_mms/first_position_mm）。
        fields["holding_pressure_bar"] = out["pressure"][0] if out["pressure"] else None
        fields["holding_velocity_mms"] = out["velocity"][0] if out["velocity"] else None
        fields["switch_position_mm"] = out["position"][0] if out["position"] else None
        fields["stage_velocity_mms"] = sp_list
        fields["stage_position_mm"] = sv_list
        fields["injection_pressure_limit_bar"] = _extract_global_pressure(
            toks, rows["pressure"], tpl, warnings)

    # 033_FIX 修复1：任一关键行锚词缺失时，hint 兜底猜到的可能是错行的值且
    # status=ok（cac666e7 左裁切实测压力/速度行互换仍 ok）。段表及所有依赖
    # 行位的输出一律置空，由上方 ROW_ANCHOR_MISSING warning 降级 review。
    anchor_void = bool(anchor_missing) and variant in (
        "multi_stage_injection", "multi_stage_holding")
    if anchor_void:
        for fkey in ("stage_velocity_mms", "stage_position_mm",
                     "stage_holding_pressure_bar", "stage_holding_time_s",
                     "stage_holding_velocity_mms"):
            if fkey in fields:
                fields[fkey] = []
        for fkey in ("holding_pressure_bar", "holding_velocity_mms",
                     "switch_position_mm", "injection_pressure_limit_bar"):
            if fkey in fields:
                fields[fkey] = None

    # 033_FIX 修复1b 错行护栏：锚词命中但整页偏移估计失败时，分段行捕获数
    # 明显失衡（2e22f85a 实测：压力行只捕到速度行单值、时间行捕到压力行 4 值）。
    # 保压变体比 压力/时间 两个分段行（速度行可为全局单值，不参与）；
    # 注射变体比 段速度/段位置 两行。min*2 < max 判异常 -> 段表置空降级。
    if not anchor_void and variant == "multi_stage_holding":
        n_p, n_t = len(sp_list), len(fields.get("stage_holding_time_s") or [])
        if n_p and n_t and min(n_p, n_t) * 2 < max(n_p, n_t):
            warnings.append(f"STAGE_ROW_MISALIGN(pressure={n_p},time={n_t})")
            fields["stage_holding_pressure_bar"] = []
            fields["stage_holding_time_s"] = []
            fields["stage_holding_velocity_mms"] = []
    elif not anchor_void and variant == "multi_stage_injection":
        n_v, n_pos = len(sp_list), len(sv_list)
        if n_v and n_pos and min(n_v, n_pos) * 2 < max(n_v, n_pos):
            warnings.append(f"STAGE_ROW_MISALIGN(velocity={n_v},position={n_pos})")
            fields["stage_velocity_mms"] = []
            fields["stage_position_mm"] = []

    slots = [t for t in toks if t.get("slot")]
    slot_captures = None  # slot 回退路径的捕获集合（Layer 1 图像观测采样用）
    if not (pressure or velocity) and not anchor_void:
        # 026_FIX：slot 槽位回退与主路径同一语义——multi_stage_injection 时
        # rows['pressure'] 行=段速度、rows['velocity'] 行=段位置；其余变体不变。
        # 035 保压真值：multi_stage_holding 时 rows['pressure'] 行=段保压压力、
        # rows['position'] 行（"时间[s]"标签锚定）=段保压时长。
        if variant == "multi_stage_injection":
            upper_key, lower_key = "stage_velocity_mms", "stage_position_mm"
        elif variant == "multi_stage_holding":
            upper_key, lower_key = "stage_holding_pressure_bar", "stage_holding_time_s"
        else:
            upper_key, lower_key = "stage_pressure_bar", "stage_velocity_mms"
        lower_key_row = "position" if variant == "multi_stage_holding" else "velocity"
        use_offset = variant in ("multi_stage_injection", "multi_stage_holding")
        if slots and all(t["text"] for t in slots):
            if use_offset:
                sp = [t for t in slots if abs(t["y"] - vrow["pressure"]) <= _half]
                sv = [t for t in slots if abs(t["y"] - vrow[lower_key_row]) <= _half]
            else:
                # 背压等未验证变体保持 029 前行为（ rows 行 ±0.035 ），不受偏移逻辑影响
                sp = [t for t in slots if abs(t["y"] - rows["pressure"]) <= 0.035]
                sv = [t for t in slots if abs(t["y"] - rows[lower_key_row]) <= 0.035]
            if sp and sv:
                fields[upper_key] = [_v(t["text"]) for t in sorted(sp, key=lambda t: t["x"])]
                fields[lower_key] = [_v(t["text"]) for t in sorted(sv, key=lambda t: t["x"])]
                slot_captures = {
                    upper_key: [(t["x"], t["y"]) for t in sorted(sp, key=lambda t: t["x"])],
                    lower_key: [(t["x"], t["y"]) for t in sorted(sv, key=lambda t: t["x"])],
                }
            else:
                fields[upper_key] = []
                fields[lower_key] = []
                warnings.append("STAGE_REJECT(unverified_grid)")
        else:
            fields[upper_key] = []
            fields[lower_key] = []
            warnings.append("STAGE_REJECT(unverified_grid)")

    # Layer 1 禁用段图像观测：对进入段数组的捕获格采样亮度判深色=禁用。
    # 仅观测不改数值——下方对布尔施加与数值完全相同的剔除与反转变换。
    stage_enabled = {}
    if img is not None and variant in ("multi_stage_injection", "multi_stage_holding"):
        captures = slot_captures
        if captures is None:
            if variant == "multi_stage_injection":
                captures = {
                    "stage_velocity_mms": [(x, cap_rows[0]) for x, *_ in pressure],
                    "stage_position_mm": [(x, cap_rows[1]) for x, *_ in velocity],
                }
            else:
                captures = {
                    "stage_holding_pressure_bar": [(x, _row_of("pressure")) for x, *_ in pressure],
                    "stage_holding_velocity_mms": [(x, _row_of("velocity")) for x, *_ in velocity],
                    "stage_holding_time_s": [(x, _row_of("position")) for x, *_ in time_cells],
                }
        stage_enabled = _stage_enabled(img, captures)

    if variant == "multi_stage_injection":
        # DEMAG 多级注射页段表在屏幕上自右向左排列（最右列为第 1 段）；
        # 契约要求段数组按物理段序输出，故在输出边界统一反转（025_FIX）。
        # 026_FIX：反转对象改为 段速度 + 段位置（本页无分段压力）。
        # 背压变体段序未经真值确认，维持屏幕序且仍为 candidate 仅预览。
        # 033_FIX 统一裁定（王为 2026-08-06）：enabled 过滤推广到注射变体——
        # 深色禁用槽任何值剔除（rank01 深色底尾段 0 实测）、浅色启用槽保留；
        # 观测缺失/长度不符时保持现状（只反转）并落 review（不猜）。
        for key in ("stage_velocity_mms", "stage_position_mm"):
            values = fields.get(key)
            if not isinstance(values, list):
                continue
            enabled = stage_enabled.get(key)
            use_enabled = enabled is not None and len(enabled) == len(values)
            if use_enabled:
                kept = [(v, e) for v, e in zip(values, enabled) if e]
                values = [v for v, _ in kept]
                enabled = [e for _, e in kept]
            elif values:
                warnings.append(f"STAGE_ENABLED_UNVERIFIED({key})")
            fields[key] = list(reversed(values))
            if enabled is not None:
                stage_enabled[key] = list(reversed(enabled))

    if variant == "multi_stage_holding":
        # 035 保压真值（app 反馈 e3ebbba2，领域确认）：保压段表同样自右向左排列
        # （最右列为第 1 段），输出边界统一反转为物理段序。
        # 033_FIX 修复2 + 统一裁定（王为 2026-08-06）：三个分段行的剔除统一以
        # Layer 1 enabled 观测为准——深色背景槽=禁用段，任何值（含非零旧值 35、
        # 时间行深色槽 1.000）剔除；浅色槽=启用段，任何值（含 0）保留。
        # 观测缺失/长度不符时回退旧"前导 0 剔除"启发式并落 review
        # （STAGE_ENABLED_UNVERIFIED，不猜）。
        # 030_FIX：单个有效速度值时回退输出 holding_velocity_mms 单值。
        for key in ("stage_holding_pressure_bar", "stage_holding_time_s",
                    "stage_holding_velocity_mms"):
            values = fields.get(key)
            if not isinstance(values, list):
                continue
            enabled = stage_enabled.get(key)
            use_enabled = enabled is not None and len(enabled) == len(values)
            if use_enabled:
                kept = [(v, e) for v, e in zip(values, enabled) if e]
                values = [v for v, _ in kept]
                enabled = [e for _, e in kept]
            else:
                if values:
                    warnings.append(f"STAGE_ENABLED_UNVERIFIED({key})")
                while values and values[0] == 0:
                    values = values[1:]
                    if enabled:
                        enabled = enabled[1:]
            fields[key] = list(reversed(values))
            if enabled is not None:
                stage_enabled[key] = list(reversed(enabled))
        hv = fields.get("stage_holding_velocity_mms")
        if isinstance(hv, list) and len(hv) == 1:
            fields["holding_velocity_mms"] = hv[0]

    if stage_enabled:
        # 对齐护栏：只保留与最终段数组逐位等长的观测
        stage_enabled = {k: v for k, v in stage_enabled.items()
                         if isinstance(fields.get(k), list) and len(v) == len(fields[k])}
        if stage_enabled:
            fields["_stage_enabled"] = stage_enabled

    fields["_page_variant"] = variant
    if variant in ("multi_stage_injection", "multi_stage_holding"):
        # 压力侧别观测（不进 fields，背压变体不观测）：注射/保压变体从压力行
        # 标签原文提取单位字符串，attach_contract 据此做 pressure_basis 运行时覆盖。
        fields["_pressure_unit_text"] = _pressure_unit_text(pressure_label)
    return fields


def _extract_optim(toks, tpl, warnings):
    spec = tpl["optimization_page"]["fields"]
    tol = tpl["optimization_page"]["cell_tolerance"]
    fields = {}
    for name, s in spec.items():
        lo, hi = s["range"]
        cands = []
        for t in toks:
            if abs(t["y"] - s["row_y"]) > tol["dy"] or abs(t["x"] - s["col_x"]) > tol["dx"]:
                continue
            v = _v_range(t["text"], lo, hi)
            if v is not None:
                cands.append((abs(t["x"] - s["col_x"]), v))
        if cands:
            cands.sort()
            fields[name] = cands[0][1]
        else:
            fields[name] = None
            warnings.append(f"CELL_MISSING({name})")
    return fields


def extract_injection_demag(toks: list[dict], template: dict, image_path=None) -> dict:
    # image_path：矫正后 PNG（可选）。传入时对段表做 Layer 1 禁用段图像观测，
    # 结果放 detail["stage_enabled"]；缺省 None 时完全保持现行为（无观测输出）。
    img = None
    if image_path is not None:
        import cv2  # 延迟导入：无图像流程不引入 cv2
        img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    warnings: list[str] = []
    stage_enabled = None
    pressure_unit_text = None
    if _is_curve(toks):
        fields = _extract_curve(toks, template["curve_page"], warnings, img=img)
        variant = fields.pop("_page_variant", "multi_stage_injection")
        stage_enabled = fields.pop("_stage_enabled", None)
        pressure_unit_text = fields.pop("_pressure_unit_text", None)
    else:
        fields = _extract_optim(toks, template, warnings)
        variant = "process_optimization"
        # 降级/回退策略：若工艺优化页大部分字段缺失（缺失率 >= 80%），自动尝试曲线页抽取
        missing_count = sum(1 for v in fields.values() if v is None)
        if missing_count >= len(fields) * 0.8 and "curve_page" in template:
            curve_warnings: list[str] = []
            curve_fields = _extract_curve(toks, template["curve_page"], curve_warnings, img=img)
            if any(v is not None for v in curve_fields.values()):
                fields = curve_fields
                warnings = curve_warnings
                variant = fields.pop("_page_variant", "multi_stage_injection")
                stage_enabled = fields.pop("_stage_enabled", None)
                pressure_unit_text = fields.pop("_pressure_unit_text", None)

    detail = {"page_variant": variant}
    if variant in ("multi_stage_injection", "multi_stage_holding"):
        detail["pressure_unit_text"] = pressure_unit_text
    if stage_enabled:
        detail["stage_enabled"] = stage_enabled
    return {"fields": fields, "heater_columns": 0,
            "warnings": warnings, "detail": detail}

