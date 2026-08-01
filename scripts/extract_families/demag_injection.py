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
    keys = ["多级注", "注射常数", "移动曲线"]
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
    ra = tpl["row_anchors"]
    hint = tpl["row_y_hint"]
    rows = {}
    for key, keys in ra.items():
        hits = [t for t in toks if _anchor_match(keys, t["text"])]
        # 「位置」等短标签会误中左栏实时值区，取与模板 y 提示最接近的命中
        rows[key] = (min(hits, key=lambda t: abs(t["y"] - hint[key]))["y"]
                     if hits else hint[key])
    out = {}
    for key in ("pressure", "velocity", "position"):
        ly = rows[key]
        # 段列：标签下方 (label, label+0.045] 且 x>0.5；图轴数字在标签上方被排除
        stages = sorted(((t["x"], _v(t["text"])) for t in toks
                         if ly - 0.005 < t["y"] <= ly + 0.045 and t["x"] > 0.5
                         and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                        key=lambda e: e[0])
        stages = [(x, v) for x, v in stages if v is not None]
        # 左列首段：标签同高 ±0.025、且在段列左侧（图轴零点 y 偏离大被排除）
        stage_x0 = stages[0][0] if stages else 1.0
        trio = sorted(((t["x"], _v(t["text"])) for t in toks
                       if abs(t["y"] - ly) <= 0.025 and 0.15 < t["x"] < stage_x0 - 0.05
                       and re.fullmatch(r"\d+\.?\d*", t["text"].strip())),
                      key=lambda e: e[0])
        trio = [(x, v) for x, v in trio if v is not None]
        out[key] = [v for _, v in trio] + [v for _, v in stages]
        if not out[key]:
            warnings.append(f"ROW_EMPTY({key})")
    fields = {
        "pressure_limit_bar": out["pressure"][0] if out["pressure"] else None,
        "first_velocity_mms": out["velocity"][0] if out["velocity"] else None,
        "first_position_mm": out["position"][0] if out["position"] else None,
    }
    # 段表拒识兜底（037 方案②约束）：列网格旁车未验证完整时 stage 数组整体置 null
    # + warning（review），严禁漂移/不完整段表流入 ok 图（error_auto_import_rate=0 优先）
    slots = [t for t in toks if t.get("slot")]
    if slots and all(t["text"] for t in slots):
        sp = [t for t in slots if abs(t["y"] - rows["pressure"]) <= 0.035]
        sv = [t for t in slots if abs(t["y"] - rows["velocity"]) <= 0.035]
        fields["stage_pressure_bar"] = [_v(t["text"]) for t in sorted(sp, key=lambda t: t["x"])]
        fields["stage_velocity_mms"] = [_v(t["text"]) for t in sorted(sv, key=lambda t: t["x"])]
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
    return {"fields": fields, "heater_columns": 0,
            "warnings": warnings, "detail": {"page_variant": variant}}
