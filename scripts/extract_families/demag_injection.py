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


def _v(text):
    m = NUM_RE.search(text)
    return float(m.group()) if m else None


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


def _extract_global_pressure(toks, pressure_row_y, tpl, warnings):
    """右上全局射胶压力上限（026_FIX 新增锚区）：x > x_min 且位于段表上 row
    上方 dy_above 带内的数值（带下限可为小幅负值：拍照矫正后该值可能与压力行同 y）；
    取最贴近段表者。找不到返回 None 并告警，不猜。"""
    spec = tpl.get("global_pressure") or {}
    x_min = spec.get("x_min", 0.75)
    dy_lo, dy_hi = spec.get("dy_above", [-0.005, 0.08])
    cands = [(t["y"], t["x"], _v(t["text"])) for t in toks
             if t["x"] > x_min
             and pressure_row_y - dy_hi <= t["y"] <= pressure_row_y - dy_lo
             and re.fullmatch(r"\d+\.?\d*", t["text"].strip())]
    cands = [c for c in cands if c[2] is not None]
    if not cands:
        warnings.append("CELL_MISSING(injection_pressure_limit_bar)")
        return None
    cands.sort(key=lambda c: (c[0], c[1]))
    return cands[-1][2]


def _extract_curve(toks, tpl, warnings):
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
    for key, keys in ra.items():
        hits = [t for t in toks if _anchor_match(keys, t["text"])]
        rows[key] = (min(hits, key=lambda t: abs(t["y"] - hint[key]))["y"]
                     if hits else hint[key])

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
    sp_same = sorted(((t["x"], _v(t["text"])) for t in toks
                      if abs(t["y"] - rows["pressure"]) <= 0.025 and t["x"] > 0.45
                      and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                     key=lambda e: e[0])
    sv_same = sorted(((t["x"], _v(t["text"])) for t in toks
                      if abs(t["y"] - rows["velocity"]) <= 0.025 and t["x"] > 0.45
                      and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                     key=lambda e: e[0])

    # 模式 2：DEMAG 多级注射页错行布局（段表整体下移一行：上 row 位于 rows['velocity']，
    # 下 row 位于 rows['position']；026_FIX：上 row=段速度、下 row=段位置）
    sp_inj = sorted(((t["x"], _v(t["text"])) for t in toks
                     if abs(t["y"] - rows["velocity"]) <= 0.025 and t["x"] > 0.60
                     and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                    key=lambda e: e[0])
    sv_inj = sorted(((t["x"], _v(t["text"])) for t in toks
                     if abs(t["y"] - rows["position"]) <= 0.025 and t["x"] > 0.60
                     and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                    key=lambda e: e[0])

    def _dedupe(arr):
        arr = [item for item in arr if item[1] is not None]
        deduped = []
        for item in arr:
            if not deduped or (item[0] - deduped[-1][0] >= 0.018):
                deduped.append(item)
            elif item[1] != deduped[-1][1] and item[0] - deduped[-1][0] > 0.01:
                deduped.append(item)
        return deduped

    sp_same, sv_same = _dedupe(sp_same), _dedupe(sv_same)
    sp_inj, sv_inj = _dedupe(sp_inj), _dedupe(sv_inj)

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
    elif len(sp_inj) >= 2 and len(sv_inj) >= 2:
        variant = "multi_stage_injection"
        pressure = sp_inj
        velocity = sv_inj
    else:
        variant = "multi_stage_injection"
        pressure = sp_same if sp_same else sp_inj
        velocity = sv_same if sv_same else sv_inj

    sp_list = [v for _, v in pressure]
    sv_list = [v for _, v in velocity]
    fields = {}

    if variant == "multi_stage_holding":
        # 035 保压真值（app 反馈 e3ebbba2，领域确认）：段表 压力[bar] 行=各段保压压力、
        # 时间[s] 行=各段保压时长（segment_duration），速度[mm/s] 行=全局保压速度设定；
        # 左列为实际值（实际切换/保压/位置/余料量）不入字段。屏幕自右向左为第 1 段起，
        # 在输出边界统一反转为物理段序并剔除最左未启用的 0 值段槽位（深灰框）。
        # 注射页字段（pressure_limit_bar/first_*/stage_pressure_bar/stage_velocity_mms 等）
        # 在本页为误标，一律不输出；找不到的行给 None/空数组 + CELL_MISSING，不猜。
        time_cells = _dedupe(sorted(
            ((t["x"], _v(t["text"])) for t in toks
             if abs(t["y"] - rows["position"]) <= 0.025 and t["x"] > 0.45
             and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
            key=lambda e: e[0]))
        time_list = [v for _, v in time_cells]
        fields["stage_holding_pressure_bar"] = sp_list
        fields["stage_holding_time_s"] = time_list
        fields["holding_velocity_mms"] = sv_list[-1] if sv_list else None
        if not sp_list:
            warnings.append("CELL_MISSING(stage_holding_pressure_bar)")
        if not time_list:
            warnings.append("CELL_MISSING(stage_holding_time_s)")
        if fields["holding_velocity_mms"] is None:
            warnings.append("CELL_MISSING(holding_velocity_mms)")
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

    slots = [t for t in toks if t.get("slot")]
    if not (pressure or velocity):
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
        lower_row_y = rows["position"] if variant == "multi_stage_holding" else rows["velocity"]
        if slots and all(t["text"] for t in slots):
            sp = [t for t in slots if abs(t["y"] - rows["pressure"]) <= 0.035]
            sv = [t for t in slots if abs(t["y"] - lower_row_y) <= 0.035]
            if sp and sv:
                fields[upper_key] = [_v(t["text"]) for t in sorted(sp, key=lambda t: t["x"])]
                fields[lower_key] = [_v(t["text"]) for t in sorted(sv, key=lambda t: t["x"])]
            else:
                fields[upper_key] = []
                fields[lower_key] = []
                warnings.append("STAGE_REJECT(unverified_grid)")
        else:
            fields[upper_key] = []
            fields[lower_key] = []
            warnings.append("STAGE_REJECT(unverified_grid)")

    if variant == "multi_stage_injection":
        # DEMAG 多级注射页段表在屏幕上自右向左排列（最右列为第 1 段）；
        # 契约要求段数组按物理段序输出，故在输出边界统一反转（025_FIX）。
        # 026_FIX：反转对象改为 段速度 + 段位置（本页无分段压力）。
        # 背压变体段序未经真值确认，维持屏幕序且仍为 candidate 仅预览。
        for key in ("stage_velocity_mms", "stage_position_mm"):
            values = fields.get(key)
            if isinstance(values, list):
                fields[key] = list(reversed(values))

    if variant == "multi_stage_holding":
        # 035 保压真值（app 反馈 e3ebbba2，领域确认）：保压段表同样自右向左排列
        # （最右列为第 1 段），输出边界统一反转为物理段序；反转前剔除屏幕最左
        # 未启用的 0 值段槽位（深灰框，0 bar/0 s 非真实段）。
        for key in ("stage_holding_pressure_bar", "stage_holding_time_s"):
            values = fields.get(key)
            if isinstance(values, list):
                while values and values[0] == 0:
                    values = values[1:]
                fields[key] = list(reversed(values))

    fields["_page_variant"] = variant
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


def extract_injection_demag(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    if _is_curve(toks):
        fields = _extract_curve(toks, template["curve_page"], warnings)
        variant = fields.pop("_page_variant", "multi_stage_injection")
    else:
        fields = _extract_optim(toks, template, warnings)
        variant = "process_optimization"
        # 降级/回退策略：若工艺优化页大部分字段缺失（缺失率 >= 80%），自动尝试曲线页抽取
        missing_count = sum(1 for v in fields.values() if v is None)
        if missing_count >= len(fields) * 0.8 and "curve_page" in template:
            curve_warnings: list[str] = []
            curve_fields = _extract_curve(toks, template["curve_page"], curve_warnings)
            if any(v is not None for v in curve_fields.values()):
                fields = curve_fields
                warnings = curve_warnings
                variant = fields.pop("_page_variant", "multi_stage_injection")

    return {"fields": fields, "heater_columns": 0,
            "warnings": warnings, "detail": {"page_variant": variant}}

