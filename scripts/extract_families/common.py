"""家族提取器共享小工具（026_PLAN S7 自 extract_fields.py 拆出，行为不变）。"""
import re

NUM_RE = re.compile(r"\d+\.?\d*")


def _anchor_match(anchor, text: str) -> bool:
    """锚点（字符串或候选字符串列表）是否为 text 的子串。"""
    return any(a in text for a in (anchor if isinstance(anchor, list) else [anchor]))


def _anchor_hits(anchor, texts: list[str]) -> bool:
    """锚点在一组 OCR 文本上是否命中（042 S03，共享分类/Profile 路由使用）。

    字符串锚点保持既有口径（任一文本包含该子串）；候选列表为 OR。
    dict 候选 {"text": ..., "min_count": N} 为计次锚点：包含该子串的文本行数
    须 >= N——用于斜拍全景丢失品牌表头时的结构指纹（如热流道数码管面板每通道
    各一个 MANU 按钮标签，多通道面板 >= 2 次，单通道温控器仅 1 次），单文本
    包含语义无法表达该类多实例证据。"""
    candidates = anchor if isinstance(anchor, list) else [anchor]
    for candidate in candidates:
        if isinstance(candidate, dict):
            needle = str(candidate.get("text", ""))
            threshold = candidate.get("min_count", 1)
            if (not needle or not isinstance(threshold, int)
                    or isinstance(threshold, bool) or threshold < 1):
                continue
            if sum(1 for t in texts if needle in t) >= threshold:
                return True
        elif any(candidate in t for t in texts):
            return True
    return False


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
