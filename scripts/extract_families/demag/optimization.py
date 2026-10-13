"""DEMAG process optimization page: bounded grid extraction."""

import re

NUM_RE = re.compile(r"\d+\.?\d*")


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
