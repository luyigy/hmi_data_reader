"""基于 OCR 输出做 UI 家族识别 + 页面识别。

输入：OCR JSON（含 lines 列表，每个 line 有 text/conf/bbox）
输出：在 JSON 中追加 ui_family, ui_family_confidence, page, page_confidence

策略：
- UI 家族：从 OCR 文本中匹配关键词（控制器级口径；各词依据见 UI_FAMILY_KEYWORDS 注释）
    - TACT（日精）/ FANUC（发那科）/ ZizES（佳明）/ TRD6（沙迪克）
    - KEBA / B_AND_R（伯乐机台的两类控制器）/ ARBURG（阿博格）/ DEMAG（德马格）
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
import re
from pathlib import Path


UI_FAMILY_KEYWORDS = {
    # TACT（日精 NISSEI 控制器）：
    #   TACT/tact — 屏幕左上 "TACT5" 标识（rec03/04/05 各页实测命中）
    #   成形条件 — NISSEI 拼写（成形 vs 他家成型），rec02 储料/炮筒 "成形条件名称：TX25022"
    #   充填量补正 / 充填过量防止 — TACT 充填控制功能项（rec02 波形/监控、储料/射出）
    "TACT": ["TACT", "tact", "成形条件", "充填量补正", "充填过量防止"],
    # FANUC（发那科 ROBOSHOT）：
    #   FANUC/ROBOSHOT/α-S 系列/NUC — 品牌与型号（NUC 为 FANUC 漏字 OCR）
    #   精密计量 — ROBOSHOT 底部 Tab（rec00 储料/射出），仅 FANUC 记录命中
    #   计量扭矩 — FANUC 监控页特征列（rec00 监控），仅 FANUC 记录命中
    #   HR模式 — FANUC HR 模式项（rec00 储料/射出），仅 FANUC 记录命中
    #   低温保持 — FANUC 炮筒页功能项（rec00 炮筒）
    #   i-MODEL — ROBOSHOT 型号栏 "α-S30iA i-MODEL B"（rec00 波形 OCR "Beries 3li-MODEL B"）
    # 发那科 = FANUC 的中文品牌名（042 S02 显式别名，不做模糊字符匹配）。
    # 部分 ROBOSHOT 屏幕标题区只清晰出现“发那科”三字（型号/ROBOSHOT 被摩尔纹/裁切
    # 误读），需要该显式别名才能稳定分到 FANUC 家族。
    "FANUC": ["FANUC", "发那科", "ROBOSHOT", "α-S", "a-S30", "S30iA", "S-iA", "NUC",
              "精密计量", "计量扭矩", "HR模式", "低温保持", "i-MODEL"],
    "ZizES": ["ZES", "ZizES", "佳明", "广东佳明"],
    "TRD6": ["TRD6", "SPT", "沙迪克", "Sodick"],
    # KEBA（伯乐 A01/B02 机台的控制器，KePlast 界面）：
    #   KEBA/KEB — 屏幕 Logo 直读（rec06 炮筒 "KEBA"；rec08 监控 "KEB" 截断）
    #   Process expert — KePlast 标题栏文字（rec11 监控/炮筒 "Process expert BOLE"）
    #   ms_data — KePlast 数据路径（rec11 监控 "ocol/ms_data/pdp/default_..."）
    #   请在条件号 — KePlast 条件号变更提示横幅（rec06/08 多页 "…时，请在条件号。…基础上更改"）
    #   熔胶同步 — KePlast 储料页功能项（rec08 储料）
    "KEBA": ["KEBA", "KEB", "Process expert", "PROCESS EXPERT", "ms_data",
             "请在条件号", "熔胶同步"],
    # B_AND_R（伯乐 B01 机台的控制器）：
    #   BKS_350 — B&R 面板型号标识（S1 核验证据）；EKS_350 为 B→E 的 OCR 误读变体，
    #   KS_350 同时覆盖两种变体（rec07 全部 5 页标题 "BOLE EKS_350"）
    #   EKS_CAP — 500EKS 竖屏面板型号栏 "500EKS_CAP"（083 S07：Z007/Z010 实拍；
    #   全仓 OCR 语料碰撞检查仅伯乐 B_AND_R 机台图命中，无跨家族冲突）
    "B_AND_R": ["BKS_350", "EKS_350", "KS_350", "EKS_CAP"],
    "ARBURG": ["ARBURG", "Arburg", "ARBUR"],  # 阿博格
    # DEMAG（德马格 NC 系列）：
    #   DEMAG/Demag — 品牌（rec15）
    #   工艺控制统计 — NC 监控页标题（rec14 监控；S1 核验提到的 NC 特征）
    #   SuperUser — NC5 登录级别（rec14 波形 "SuperUser 24 MWE曲线"）
    #   多级背压 / 移动曲线 / 冷启动保护 / 余料量 — NC 储料/射出/炮筒页术语
    #   （rec14 各页；全库碰撞检查仅 rec14/rec15 命中）
    #   多级注射 / 多级保压 / 多级预塑 — NC 页面标题（2026-08-05 029_FIX：
    #   裁切拍摄的保压页失去"余料量"等左列锚词导致整族 unknown 误拒；
    #   全仓碰撞检查仅 DEMAG 模板命中"多级X"标题族，无跨家族冲突）
    #   同步加热 / 油预热 / 延时手动降低 — NC 温度页右下功能块术语（083 S06：
    #   实拍图仅"冷启动保护"单条弱命中 0.819 < 0.9 门禁；前两者本就在
    #   demag.temperature.json family_detect_groups 作为模板指纹族证；
    #   全仓 OCR 语料碰撞检查三词仅命中 DEMAG 图，无跨家族冲突）
    "DEMAG": ["DEMAG", "Demag", "工艺控制统计", "SuperUser", "多级背压",
              "移动曲线", "冷启动保护", "余料量",
              "多级注射", "多级保压", "多级预塑",
              "同步加热", "油预热", "延时手动降低"],
    # 注：BOLE（伯乐）是机器品牌而非控制器家族，已从关键词表移除（2026-07-30 T2）。
    # 伯乐机台的控制器级识别由 KEBA / B_AND_R 承担（S1 标签口径）；
    # "注射"（DEMAG 也在用）与 "射胶"（KEBA/B_AND_R 混用）无区分度，不收录。
}

PAGE_KEYWORDS = {
    "temperature": ["温度", "炮筒温度", "炮温", "Barrel Temp", "喷嘴/料筒"],
    "injection_metering": ["射出", "保压", "计量", "射出·计量", "射出·保压", "射出/保压"],
    "storage_cooling": ["储料", "冷却", "储料·冷却"],
    "monitor_curve": ["监视", "曲线", "波形"],
    "settings": ["设定", "参数设定"],
    "preheat": ["预热"],
}


def score_all_families(lines: list[dict]) -> dict[str, float]:
    """返回各 UI 家族的得分的全向量（{family: score}，键序同 UI_FAMILY_KEYWORDS）。

    打分规则与 find_ui_family 一致：每行文本命中某家族任一关键词即加该行 conf；
    再按 min(1.0, 原始分) 逐家族归一化（单次匹配上限 1.0），保留 3 位小数。
    供 record 级聚合（scripts/aggregate_record.py）做置信度投票使用。
    """
    scores: dict[str, float] = {k: 0.0 for k in UI_FAMILY_KEYWORDS}

    for line in lines:
        text = line["text"]
        conf = line["conf"]
        for family, kws in UI_FAMILY_KEYWORDS.items():
            for kw in kws:
                if kw in text:
                    # 文本包含关键词 -> 加分
                    scores[family] += conf
                    break

    return {k: round(min(1.0, v), 3) for k, v in scores.items()}


def find_ui_family(lines: list[dict]) -> tuple[str, float]:
    """返回 (family, confidence)。无匹配 -> (unknown, 0.0)。"""
    scores = score_all_families(lines)

    if not any(scores.values()):
        return "unknown", 0.0

    best = max(scores, key=scores.get)
    return best, scores[best]


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

    # FANUC 喷嘴/料筒页同时显示注塑统计区（保压/计量），通用词频会误判为
    # injection_metering；仅完整温度表结构命中时采用这个精确页面签名。
    texts = [line["text"] for line in lines]
    if any("喷嘴/料筒" in text for text in texts) and all(
            any(anchor in text for text in texts)
            for anchor in ("现在", "输出", "上限", "设定", "下限")):
        conf = max(line["conf"] for line in lines if "喷嘴/料筒" in line["text"])
        return "temperature", round(conf, 3)

    # DEMAG 温度页（083 S10）：标题「温度」+ 实际/设定/上偏差/下偏差行标签
    # 同时在场即温度表页。通用位置启发会把行标签 '设定[℃]' 的首次命中当作
    # settings 页标题（×5 权重）反超单独的「温度」标题（实测 Z002 rank12、
    # Z005 rank13 误分 settings，DEMAG 速率旁车不生成、列顶速率整列缺读）。
    # 全仓 587 份 OCR 语料碰撞检查：签名命中 16 份全部为温度页，无误伤。
    # 083 S11：偏差行标签锚点单字容差——'偏' 在屏摄 OCR 下被误读为形近字
    # （实测 Z005 rank29 '上福差℃]'/'下福差℃'，锚点缺失退回位置启发误分
    # settings）；按 上.差/下.差 容差后全仓 596 份语料新增命中 10 份
    # （6 张去重）全部为温度页，零误伤。
    if any("温度" in text for text in texts) and all(
            any(anchor in text for text in texts)
            for anchor in ("实际", "设定")) and all(
            any(re.search(pat, text) for text in texts)
            for pat in (r"上.差", r"下.差")):
        conf = max(line["conf"] for line in lines if "温度" in line["text"])
        return "temperature", round(conf, 3)

    # DEMAG 温度页无标题变体（083 S13/095 S02 B013）：整机实拍把顶部「温度」
    # 标题裁出画面时上一签名不命中（实测 Z005 rank18 误分 settings，DEMAG 速率
    # 旁车不生成、列顶速率整列缺读，真值比对缺 4 格）。结构锚点改判：
    # 实际/设定/上.差/下.差行标签 + 速率行 + 区段列头（喷嘴/料口/区N 至少两个）
    # 同时在场即 DEMAG 温度表页；缺「温度」标题时不回退位置启发误分 settings。
    if all(any(anchor in text for text in texts)
           for anchor in ("实际", "设定", "速率")) and all(
            any(re.search(pat, text) for text in texts)
            for pat in (r"上.差", r"下.差")):
        zone_hits = sum(1 for pat in ("喷嘴", "料口", r"区\s*\d")
                        if any(re.search(pat, text) for text in texts))
        if zone_hits >= 2:
            # 置信度取 DEMAG 特征锚点（速率/区段列头）最高值——不能用低置信的
            # 偏差行残字（'上福差' 0.72 会把 profile_confidence 压过门禁线）。
            conf = max(line["conf"] for line in lines
                       if any(kw in line["text"] for kw in ("喷嘴", "料口", "速率"))
                       or re.search(r"区\s*\d", line["text"]))
            return "temperature", round(conf, 3)

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
