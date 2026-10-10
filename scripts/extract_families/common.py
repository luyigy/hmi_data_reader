"""家族提取器共享小工具（026_PLAN S7 自 extract_fields.py 拆出，行为不变）。"""
import re

import numpy as np

NUM_RE = re.compile(r"\d+\.?\d*")


def bbox_grayscale_contrast(gray, bbox):
    """5–95 percentile contrast inside a rectified-image OCR value box."""
    if gray is None or gray.ndim != 2 or bbox is None or len(bbox) != 4:
        return None
    height, width = gray.shape
    x1, y1, x2, y2 = map(int, bbox)
    if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height) or (x2-x1)*(y2-y1) < 100:
        return None
    low, high = np.percentile(gray[y1:y2, x1:x2], [5, 95])
    return float(high - low)

# 繁简归一（083 S01）：TACT5 等界面行标签实测为繁体（設定温度/現在溫度/控制輸出），
# OCR 原样输出后简体锚点失配导致整行丢失。锚点均为简体，仅归一 OCR 文本侧；
# 映射表只收实测出现且无误判歧义的字符。
_TRAD2SIMP = str.maketrans({
    "設": "设", "溫": "温", "現": "现", "輸": "输", "頭": "头", "噴": "喷",
})


def norm_cjk(text: str) -> str:
    """OCR 文本繁简归一（锚点匹配专用，不改写原始 text）。"""
    return text.translate(_TRAD2SIMP)


def _anchor_match(anchor, text: str) -> bool:
    """锚点（字符串或候选字符串列表）是否为 text 的子串（OCR 侧繁简归一后比较）。"""
    norm = norm_cjk(text)
    return any(a in norm for a in (anchor if isinstance(anchor, list) else [anchor]))


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
            if sum(1 for t in texts if needle in norm_cjk(t)) >= threshold:
                return True
        elif any(candidate in norm_cjk(t) for t in texts):
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


def _fit_slope_rows(toks: list[dict], row_tol: float = 0.03) -> float:
    """多行混合 token 的稳健斜率：逐行（y 聚类）各自拟合后取跨行中位。

    083 S05：多行 token 直接整体最小二乘时，各行 x 分布差异会虚构斜率
    （伯乐 Z034 图形行偏右、设定行偏左，k=-0.083 致设定行右半被行带切掉）。
    单行内部 x 分布天然同构，逐行拟合取中位可消除该混行伪斜率；
    没有任何一行可拟合（<3 点或无 x 跨度）时回退整体拟合。
    """
    rows: list[list[dict]] = []
    for t in sorted(toks, key=lambda t: t["y"]):
        if rows and abs(t["y"] - rows[-1][-1]["y"]) <= row_tol:
            rows[-1].append(t)
        else:
            rows.append([t])
    slopes = [_fit_slope(row) for row in rows if len(row) >= 3]
    if not slopes:
        return _fit_slope(toks)
    slopes.sort()
    return slopes[len(slopes) // 2]


def _affine_fit_columns(measured: list[float], tpl_centers: list[float],
                        x_min: float, x_max: float = 0.97,
                        hdr_anchors: dict[int, str] | None = None,
                        labels_all: list[str] | None = None,
                        max_resid: float = 0.02) -> tuple[list[float], list[int]] | None:
    """实测列簇到模板列位的有序仿射配准（y = a*x + b），返回 (拟合列位, 缺失列下标)。

    083 S05 自 b_and_r 提取器内联逻辑提为共享助手，供提取器与逐格旁车网格
    共用。安全性：列头锚点（hdr_anchors: 实测簇下标 -> 模板列名）优先约束；
    无锚点时要求拟合列位整体落在 (x_min, x_max]（x_min 通常取行标签右缘——
    数据列不可能叠在标签列上），且最优组合的残差显著优于次优（小于其一半，
    防「缺首列/缺中列」等错位组合同分误选），否则判不可信返回 None，维持
    调用方原有兜底，不把猜测列位写进结果。
    """
    from itertools import combinations
    n = len(measured)
    if not (3 <= n < len(tpl_centers)):
        return None
    passing = []
    for sub in combinations(range(len(tpl_centers)), n):
        if hdr_anchors and any(
                j in hdr_anchors and (labels_all or [])[sub[j]] != hdr_anchors[j]
                for j in range(n)):
            continue
        xs = [tpl_centers[s] for s in sub]
        mx = sum(xs) / n
        my = sum(measured) / n
        denom = sum((x - mx) ** 2 for x in xs)
        if denom <= 0:
            continue
        a = sum((xs[i] - mx) * (measured[i] - my) for i in range(n)) / denom
        b = my - a * mx
        if not 0.5 <= a <= 1.7:
            continue
        resid = sum(abs(a * xs[i] + b - measured[i]) for i in range(n)) / n
        if resid > max_resid:
            continue
        fitted = [a * x + b for x in tpl_centers]
        if fitted[0] <= x_min or fitted[-1] > x_max:
            continue
        passing.append((resid, fitted, [j for j in range(len(tpl_centers)) if j not in sub]))
    if not passing:
        return None
    passing.sort(key=lambda e: e[0])
    if hdr_anchors:
        return passing[0][1], passing[0][2]
    if len(passing) > 1 and passing[0][0] > 0.5 * passing[1][0]:
        return None
    return passing[0][1], passing[0][2]


def _num(t: dict) -> float | None:
    m = NUM_RE.search(t["text"])
    return float(m.group()) if m else None
