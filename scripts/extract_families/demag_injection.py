"""DEMAG 射出/保压页提取（035_PLAN 第二波新增，双变体）。

- 多级注射曲线页：行（压力/速度/位置）内数值按 x 排序，首值=首段，其余=stage 数组；
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


def _extract_curve(toks, tpl, warnings):
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

    fields = {
        "pressure_limit_bar": out["pressure"][0] if out["pressure"] else None,
        "first_velocity_mms": out["velocity"][0] if out["velocity"] else None,
        "first_position_mm": out["position"][0] if out["position"] else None,
    }

    # 多段表格抽取逻辑（右侧 x > 0.45）：
    # 模式 1：同行布局（多级保压 / 多级背压页：阶段压力在 rows['pressure']，阶段速度在 rows['velocity']）
    sp_same = sorted(((t["x"], _v(t["text"])) for t in toks
                      if abs(t["y"] - rows["pressure"]) <= 0.025 and t["x"] > 0.45
                      and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                     key=lambda e: e[0])
    sv_same = sorted(((t["x"], _v(t["text"])) for t in toks
                      if abs(t["y"] - rows["velocity"]) <= 0.025 and t["x"] > 0.45
                      and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                     key=lambda e: e[0])

    # 模式 2：DEMAG 多级注射页错行布局（阶段压力位于 rows['velocity']，阶段速度位于 rows['position']）
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

    if len(sp_same) >= 2 and len(sv_same) >= 2:
        pressure = sp_same
        velocity = sv_same
    elif len(sp_inj) >= 2 and len(sv_inj) >= 2:
        pressure = sp_inj
        velocity = sv_inj
    else:
        pressure = sp_same if sp_same else sp_inj
        velocity = sv_same if sv_same else sv_inj

    slots = [t for t in toks if t.get("slot")]
    if pressure or velocity:
        fields["stage_pressure_bar"] = [v for _, v in pressure]
        fields["stage_velocity_mms"] = [v for _, v in velocity]
    elif slots and all(t["text"] for t in slots):
        sp = [t for t in slots if abs(t["y"] - rows["pressure"]) <= 0.035]
        sv = [t for t in slots if abs(t["y"] - rows["velocity"]) <= 0.035]
        if sp and sv:
            fields["stage_pressure_bar"] = [_v(t["text"]) for t in sorted(sp, key=lambda t: t["x"])]
            fields["stage_velocity_mms"] = [_v(t["text"]) for t in sorted(sv, key=lambda t: t["x"])]
        else:
            fields["stage_pressure_bar"] = []
            fields["stage_velocity_mms"] = []
            warnings.append("STAGE_REJECT(unverified_grid)")
    else:
        fields["stage_pressure_bar"] = []
        fields["stage_velocity_mms"] = []
        warnings.append("STAGE_REJECT(unverified_grid)")
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
        variant = "multi_stage_injection"
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
                variant = "multi_stage_injection"

    return {"fields": fields, "heater_columns": 0,
            "warnings": warnings, "detail": {"page_variant": variant}}

