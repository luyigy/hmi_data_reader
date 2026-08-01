"""家族提取器共享小工具（026_PLAN S7 自 extract_fields.py 拆出，行为不变）。"""
import re

NUM_RE = re.compile(r"\d+\.?\d*")


def _anchor_match(anchor, text: str) -> bool:
    """锚点（字符串或候选字符串列表）是否为 text 的子串。"""
    return any(a in text for a in (anchor if isinstance(anchor, list) else [anchor]))


def _fit_slope(toks: list[dict]) -> float:
    """拟合 y = k*(x-0.5) + c 的斜率 k（点需 ≥3 且有 x 跨度，否则 0）。"""
    if len(toks) < 3:
        return 0.0
    mx = sum(t["x"] for t in toks) / len(toks)
    my = sum(t["y"] for t in toks) / len(toks)
    denom = sum((t["x"] - mx) ** 2 for t in toks)
    if denom < 1e-6:
        return 0.0
    return sum((t["x"] - mx) * (t["y"] - my) for t in toks) / denom


def _num(t: dict) -> float | None:
    m = NUM_RE.search(t["text"])
    return float(m.group()) if m else None
