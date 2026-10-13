"""DEMAG 射出/保压页提取（035_PLAN 第二波新增，双变体）。

- 多级注射曲线页（026_FIX 领域确认语义）：右侧段表上 row=各段射胶速度 mm/s、
  下 row=各段起点位置 mm（本页无分段压力）；左列 压力/速度/位置 =
  保压压力/保压速度/V-P 切换位置；右上为全局射胶压力上限（全段通用）。
- 工艺优化页：按模板 (row_y, col_x) 网格取设定值（左灰框，右蓝框为实际值不取）。
返回结构同 keba。
"""
import re

from ..common import _anchor_match, _fit_slope, _num  # noqa: F401
from .holding import build_holding_fields, normalize_holding_stages
from .injection_page import build_injection_fields, normalize_injection_stages
from .metering import build_metering_fields

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


# 035_PLAN §3：同格主 OCR 与 ocr_variant 数值异值的冲突分类与文案。10/100 倍关系
# （疑似摩尔纹吞小数点）→ MOIRE_DECIMAL_SUSPECT；其余 → VALUE_CONFLICT。0 值不参与
# 倍数判定（避免除零或近似把普通差异误标成摩尔嫌疑）。调用方已保证 main != variant。
def _ocr_conflict_code(main: float, variant: float) -> str:
    if main and variant:
        big, small = (main, variant) if main > variant else (variant, main)
        ratio = big / small
        if abs(ratio - 10.0) < 1e-9 or abs(ratio - 100.0) < 1e-9:
            return "MOIRE_DECIMAL_SUSPECT"
    return "VALUE_CONFLICT"


def _ocr_conflict_msg(row_label: str, main: float, variant: float) -> str:
    """035_PLAN §5：含主值/变体值/来源，不记录图片或其他敏感内容。"""
    return f"{_ocr_conflict_code(main, variant)}(row={row_label} main={main} variant={variant} src=ocr_variant)"


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
    # 036_FIX：取带内最高（y 最小）候选；同高度取最右（x 最大）。
    # 全局压力在段表上方右上区；原"取最贴近段表（y 最大）"在降采样几何下会
    # 抓到段表首行数值（rank05 降采样后 110→90 实测回归）。
    cands.sort(key=lambda c: (c[0], -c[1]))
    return cands[0][2]


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
        # 033_FIX 修复3：slot 段网格旁车与 ocr_variant（CLAHE/摩尔抑制）属变体来源，
        # 同格冲突时主 OCR 值优先。返回来源标签（None=主 OCR）而非布尔——truthy 语义
        # 不变（None 假、字符串真），035_PLAN 起据此区分：仅 ocr_variant 同格异值进诚实降级。
        if t.get("slot"):
            return "slot"
        if t.get("src") == "ocr_variant":
            return "ocr_variant"
        return None

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

    def _dedupe(arr, row_label=""):
        # 033_FIX 修复3：同格（x 间距 <0.018）异值冲突时主 OCR 值优先
        # （rank02 段网格旁车 '004500' 盖住主 OCR '45.00' 实测）；冲突双方
        # 无主从之分时保持原行为（间距 >0.01 且异值两个都留）。
        # 035_PLAN：主 OCR 与 ocr_variant 同格数值异值不再静默选主值——保留主值
        # 供复核展示，另输出 MOIRE_DECIMAL_SUSPECT/VALUE_CONFLICT warning 使最终
        # status=review 且禁止自动应用（slot 旁车不进本规则）。同值异写（5 与 5.0）
        # 在上方 `item[1] != deduped[-1][1]` float 比较处被判同值，不进本分支、不告警。
        arr = [item for item in arr if item[1] is not None]
        deduped = []
        for item in arr:
            if not deduped or (item[0] - deduped[-1][0] >= 0.018):
                deduped.append(item)
            elif item[1] != deduped[-1][1]:
                last = deduped[-1]
                if last[2] and not item[2]:
                    deduped[-1] = item  # 变体在前、主 token 在后：替换
                    if last[2] == "ocr_variant":
                        warnings.append(_ocr_conflict_msg(row_label,
                                                          main=item[1], variant=last[1]))
                elif item[2] and not last[2]:
                    pass  # 主 token 在前：丢弃变体
                    if item[2] == "ocr_variant":
                        warnings.append(_ocr_conflict_msg(row_label,
                                                          main=last[1], variant=item[1]))
                elif item[0] - last[0] > 0.01:
                    deduped.append(item)
        return deduped

    sp_same, sv_same = _dedupe(sp_same, "same.pressure_row"), _dedupe(sv_same, "same.velocity_row")
    sp_inj, sv_inj = _dedupe(sp_inj, "inj.velocity_row"), _dedupe(sv_inj, "inj.position_row")

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
        fields, time_cells = build_holding_fields(
            toks, _row_of, _tol, _dedupe, _var, _v, sp_list, sv_list, warnings)
    elif variant == "multi_stage_back_pressure":
        fields = build_metering_fields(toks, out, _v)
    else:
        fields = build_injection_fields(
            toks, rows, tpl, warnings, out, sp_list, sv_list, _extract_global_pressure)

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
        normalize_injection_stages(fields, stage_enabled, warnings)
    elif variant == "multi_stage_holding":
        normalize_holding_stages(fields, stage_enabled, warnings)

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
