"""基于 OCR 输出做 UI 家族识别 + 页面识别。

输入：OCR JSON（含 lines 列表，每个 line 有 text/conf/bbox）
输出：在 JSON 中追加 ui_family, ui_family_confidence, page, page_confidence

策略：
- UI 家族：从 OCR 文本中匹配关键词
    - "TACT": ["TACT", "tact"]
    - "FANUC": ["FANUC", "ROBOSHOT", "α-S", "α-S30iA"]
    - "ZizES": ["ZES", "ZizES", "佳明"]
    - "TRD6": ["TRD6", "SPT", "沙迪克", "Sodick"]
- 页面：从常见 Tab 标题识别
    - "温度" / "炮筒温度" -> temperature
    - "射出" / "保压" / "计量" -> injection_metering
    - "储料" / "冷却" -> storage_cooling
    - "监视" / "曲线" -> monitor_curve
    - "设定" -> settings
    - "预热" -> preheat

置信度：基于关键词位置（标题区域 vs 正文）+ 文本置信度平均。

用法：
    python scripts/classify_ui.py <ocr.json>... --output <report.json>
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


UI_FAMILY_KEYWORDS = {
    "TACT": ["TACT", "tact"],
    "FANUC": ["FANUC", "ROBOSHOT", "α-S", "a-S30", "S30iA", "S-iA", "NUC"],
    "ZizES": ["ZES", "ZizES", "佳明"],
    "TRD6": ["TRD6", "SPT", "沙迪克", "Sodick"],
}

PAGE_KEYWORDS = {
    "temperature": ["温度", "炮筒温度", "炮温", "Barrel Temp"],
    "injection_metering": ["射出", "保压", "计量", "射出·计量", "射出·保压", "射出/保压"],
    "storage_cooling": ["储料", "冷却", "储料·冷却"],
    "monitor_curve": ["监视", "曲线", "波形"],
    "settings": ["设定", "参数设定"],
    "preheat": ["预热"],
}


def find_ui_family(lines: list[dict]) -> tuple[str, float]:
    """返回 (family, confidence)。无匹配 -> (unknown, 0.0)。"""
    scores: dict[str, float] = {k: 0.0 for k in UI_FAMILY_KEYWORDS}
    matches: dict[str, list[str]] = {k: [] for k in UI_FAMILY_KEYWORDS}

    for line in lines:
        text = line["text"]
        conf = line["conf"]
        for family, kws in UI_FAMILY_KEYWORDS.items():
            for kw in kws:
                if kw in text:
                    # 文本包含关键词 -> 加分
                    scores[family] += conf
                    matches[family].append(text)
                    break

    if not any(scores.values()):
        return "unknown", 0.0

    best = max(scores, key=scores.get)
    # 归一化：单次匹配上限 1.0；top score / 1.0
    raw = scores[best]
    norm = min(1.0, raw)
    return best, round(norm, 3)


def find_page(lines: list[dict]) -> tuple[str, float]:
    """返回 (page, confidence)。无匹配 -> (unknown, 0.0)。

    评分策略：
    - 把所有匹配按 y_min 排序
    - 第一个匹配（最靠上的）权重 × 5（视为页面标题）
    - 后续匹配权重 × 0.5（视为 Tab 列表里的邻居）
    - 后续匹配里，距第一个匹配 > 200px 的（视为页面正文）权重 × 2
    """
    if not lines:
        return "unknown", 0.0

    # 收集所有 (page, y_min, conf)
    hits: list[tuple[str, float, float]] = []
    for line in lines:
        text = line["text"]
        conf = line["conf"]
        y = line["bbox"]["y_min"]
        for page, kws in PAGE_KEYWORDS.items():
            for kw in kws:
                if kw in text:
                    hits.append((page, y, conf))
                    break

    if not hits:
        return "unknown", 0.0

    # 按 y 排序，找每个 page 的最早出现
    earliest: dict[str, tuple[float, float]] = {}
    for page, y, conf in hits:
        if page not in earliest or y < earliest[page][0]:
            earliest[page] = (y, conf)

    scores: dict[str, float] = {k: 0.0 for k in PAGE_KEYWORDS}
    first_ys: dict[str, float] = {k: 99999.0 for k in PAGE_KEYWORDS}
    for page, y, conf in hits:
        first_y = earliest[page][0]
        if abs(y - first_y) < 5:
            # 该 page 的最早匹配 -> 视为页面标题
            scores[page] += conf * 5.0
        elif y - first_y > 200:
            # 远离首次匹配的 -> 视为页面正文
            scores[page] += conf * 2.0
        else:
            # 接近首次匹配但不是首次 -> 视为 Tab 邻居
            scores[page] += conf * 0.5

    best = max(scores, key=scores.get)
    raw = scores[best]
    norm = min(1.0, raw / 5.0)
    return best, round(norm, 3)


def classify(ocr_path: Path) -> dict:
    data = json.loads(ocr_path.read_text())
    lines = data.get("lines", [])

    family, family_conf = find_ui_family(lines)
    page, page_conf = find_page(lines)

    result = dict(data)
    result["ui_family"] = family
    result["ui_family_confidence"] = family_conf
    result["page"] = page
    result["page_confidence"] = page_conf

    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ocr_jsons", nargs="+")
    ap.add_argument("--output", "-o", required=True)
    args = ap.parse_args()

    out = []
    for j in args.ocr_jsons:
        p = Path(j)
        if not p.is_file():
            continue
        out.append(classify(p))

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"[classify] {len(out)} files -> {args.output}")
    for r in out:
        print(f"  {r['filename']}: {r['ui_family']} ({r['ui_family_confidence']}) / {r['page']} ({r['page_confidence']})")


if __name__ == "__main__":
    main()