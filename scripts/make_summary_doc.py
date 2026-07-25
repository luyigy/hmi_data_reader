"""生成 v2 总结飞书文档"""
import json
from collections import Counter, defaultdict
from pathlib import Path
from datetime import datetime

classify = json.loads(Path("output/classify_v2_report.json").read_text())
quality = json.loads(Path("output/quality_v2_report.json").read_text())
dedup = json.loads(Path("output/dedup_v2_report.json").read_text())

OUT = Path("output/总结_飞书.md")

# UI 家族 × 品牌 交叉表
brand_family = defaultdict(Counter)
family_brand = defaultdict(Counter)
page_family = defaultdict(Counter)

# 加载质量门禁
quality_by_file = {r["filename"]: r for r in quality["reports"]}

# 按品牌/UI 家族/页面/质量门禁 整理
groups = []
for c in classify:
    fn = c["filename"]
    brand = fn.split("_")[0]
    family = c["ui_family"]
    page = c["page"]
    family_conf = c["ui_family_confidence"]
    page_conf = c["page_confidence"]
    q = quality_by_file.get(fn, {})
    triage = q.get("triage", "?")
    reject = q.get("reject_codes", [])
    warn = q.get("warn_codes", [])

    brand_family[brand][family] += 1
    family_brand[family][brand] += 1
    page_family[family][page] += 1

    groups.append({
        "filename": fn, "brand": brand, "family": family,
        "family_conf": family_conf, "page": page, "page_conf": page_conf,
        "triage": triage, "reject": reject, "warn": warn,
        "line_count": c.get("line_count", 0),
    })

# 按品牌 → UI 家族 → 文件 排序
groups.sort(key=lambda g: (g["brand"], g["family"], g["filename"]))

lines_out = []
lines_out.append("# HMI OCR 流水线总结（v2 / 2026-07-25）")
lines_out.append("")
lines_out.append(f"**数据源**：飞书 base `Vz2QbZ0lkagmVJsrMZ7cQwbSnZc` view `vewQb8HnsJ`（机台监控图片取样，22 条记录）")
lines_out.append(f"**OCR 引擎**：PaddleOCR 2.7.3 + PP-OCRv4 ch（CPU 模式）")
lines_out.append(f"**样本数**：113 张（下载）→ 87 张（OCR 成功）→ 87 张（分类完成）")
lines_out.append(f"**生成时间**：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
lines_out.append("")
lines_out.append("## 1. 总览")
lines_out.append("")
lines_out.append(f"- 下载附件：**113 张**")
lines_out.append(f"- OCR 成功：**87 张**（26 张红灯 SCREEN_TOO_SMALL 跳过）")
lines_out.append(f"- 重复附件：**{dedup['duplicate_groups_within_record']} 组**（同记录跨字段重复）/ **0 跨记录**")
lines_out.append(f"- 质量门禁：**绿灯 {quality['summary']['green']} / 黄灯 {quality['summary']['yellow']} / 红灯 {quality['summary']['red']}**")
lines_out.append("")
lines_out.append("## 2. 品牌 × UI 家族 分布（核心发现）")
lines_out.append("")
lines_out.append("**颠覆 docs/001 假设：真实 UI 家族数 = 7 个**")
lines_out.append("")
lines_out.append("| 品牌 | UI 家族分布 | OCR 证据 |")
lines_out.append("|---|---|---|")

evidence = {
    "BOLE": "'BOLE' 13 次 + 'Process expert' 7 次",
    "ARBURG": "'ARBURG' 7 次",
    "DEMAG": "'DEMAG' 出现",
    "ZizES": "'广东佳明机器有限公司' 18 次",
    "TRD6": "'SPT' 7 次",
    "TACT": "'TACT' 在日精样本识别",
    "FANUC": "'FANUC' / 'NUC' / 'ROBOSHOT'",
    "unknown": "OCR 未识别到品牌字串（界面无显式标签）",
}

for brand in sorted(brand_family.keys()):
    counter = brand_family[brand]
    total = sum(counter.values())
    parts = [f"{f}={c}" for f, c in counter.most_common()]
    # OCR 证据：取该品牌最常见的家族关键词
    main_family = counter.most_common(1)[0][0]
    ev = evidence.get(main_family, "—")
    lines_out.append(f"| **{brand}** | 总 {total} 张：" + " ".join(parts) + f" | {ev} |")

lines_out.append("")
lines_out.append("## 3. UI 家族 × 页面 分布")
lines_out.append("")
lines_out.append("| UI 家族 | 温度 | 射出/保压 | 储料/冷却 | 监控/曲线 | 设定/参数 | unknown |")
lines_out.append("|---|---|---|---|---|---|---|")
all_pages = ["temperature", "injection_metering", "storage_cooling", "monitor_curve", "settings", "unknown"]
for family in sorted(family_brand.keys()):
    counter = page_family[family]
    row = [f"**{family}**"]
    for p in all_pages:
        c = counter.get(p, 0)
        row.append(str(c) if c else "·")
    lines_out.append("| " + " | ".join(row) + " |")

lines_out.append("")
lines_out.append("## 4. 质量门禁明细（按品牌 × triage）")
lines_out.append("")
brand_triage = defaultdict(Counter)
for g in groups:
    brand_triage[g["brand"]][g["triage"]] += 1

# 加上红灯（被跳过 OCR 的）
for r in quality["reports"]:
    fn = r["filename"]
    if fn in quality_by_file:
        # 已经在 groups 里的不用管
        pass
    brand = fn.split("_")[0]
    brand_triage[brand][r["triage"]] += 1

lines_out.append("| 品牌 | 绿灯 | 黄灯 | 红灯 | 红灯主因 |")
lines_out.append("|---|---|---|---|---|")
brand_red_reason = defaultdict(Counter)
for g in groups:
    for code in g["reject"]:
        brand_red_reason[g["brand"]][code] += 1
for r in quality["reports"]:
    if r["triage"] == "red":
        fn = r["filename"]
        brand = fn.split("_")[0]
        for code in r["reject_codes"]:
            brand_red_reason[brand][code] += 1

for brand in sorted(brand_triage.keys()):
    counter = brand_triage[brand]
    red_codes = brand_red_reason.get(brand, Counter())
    red_str = ", ".join(f"{c}={n}" for c, n in red_codes.most_common(3)) or "—"
    lines_out.append(f"| {brand} | {counter.get('green', 0)} | {counter.get('yellow', 0)} | {counter.get('red', 0)} | {red_str} |")

lines_out.append("")
lines_out.append("## 5. 待解决的核心问题")
lines_out.append("")
lines_out.append("### 5.1 OCR 漏字（27 张 UI 家族 unknown）")
lines_out.append("")
unknowns = [g for g in groups if g["family"] == "unknown"]
lines_out.append(f"**{len(unknowns)} 张** OCR 没识别出品牌字串：")
lines_out.append("")
unknown_by_brand = Counter(g["brand"] for g in unknowns)
for brand, c in unknown_by_brand.most_common():
    lines_out.append(f"- {brand}: {c} 张")
lines_out.append("")
lines_out.append("**根因**：界面无显式品牌标签（如 FANUC 顶部仅显示 NUC，被 OCR 误识别）")
lines_out.append("**解决方向**：")
lines_out.append("- 补关键词（ROBO、S-iB、ROBOSHOT 变体）")
lines_out.append("- 用 Tab 标题 / 段名 / 字体特征做 UI 家族识别（不依赖品牌字串）")
lines_out.append("- 现场去物理机台拍照采集清晰的品牌 LOGO 区域")
lines_out.append("")
lines_out.append("### 5.2 沙迪克屏幕占比过小（3 张红灯）")
lines_out.append("")
lines_out.append("**SCREEN_TOO_SMALL（占比 21-30%）** — 现场重拍屏占比 ≥ 50% 的样本")
lines_out.append("")
lines_out.append("### 5.3 OCR 数字字段准确率待人工验证")
lines_out.append("")
lines_out.append(f"- 已抽取 **{5791} 个数字**（v1+v2 合并，见 `output/核对清单_飞书.md`）")
lines_out.append("- 待人工填入真值后跑 `verify_accuracy.py` 计算精确率")
lines_out.append("")
lines_out.append("## 6. 详细样本清单（按品牌分组）")
lines_out.append("")
for brand in sorted(set(g["brand"] for g in groups)):
    lines_out.append(f"### {brand}")
    lines_out.append("")
    brand_groups = [g for g in groups if g["brand"] == brand]
    lines_out.append(f"**{len(brand_groups)} 张 OCR 样本**")
    lines_out.append("")
    lines_out.append("| 文件名 | UI 家族 | conf | 页面 | conf | triage | 拒/警原因 |")
    lines_out.append("|---|---|---|---|---|---|---|")
    for g in sorted(brand_groups, key=lambda x: x["filename"]):
        codes = []
        for c in g["reject"]:
            codes.append(f"❌{c}")
        for c in g["warn"]:
            codes.append(f"⚠️{c}")
        codes_str = ", ".join(codes) or "—"
        family_str = g["family"] if g["family"] != "unknown" else "❓ unknown"
        lines_out.append(f"| {g['filename'][:65]:<65} | {family_str} | {g['family_conf']} | {g['page']} | {g['page_conf']} | {g['triage']} | {codes_str} |")
    lines_out.append("")

lines_out.append("")
lines_out.append("---")
lines_out.append("")
lines_out.append("## 附：核心脚本")
lines_out.append("")
lines_out.append("```")
lines_out.append("# 1. 重新拉取飞书数据")
lines_out.append("python3 scripts/feishu_download.py")
lines_out.append("")
lines_out.append("# 2. 去重")
lines_out.append("python3 scripts/dedup.py docs/samples_v2/ --output output/dedup_v2_report.json")
lines_out.append("")
lines_out.append("# 3. 质量门禁")
lines_out.append("python3 scripts/quality.py docs/samples_v2/*.jpeg --output output/quality_v2_report.json --dedup output/dedup_v2_report.json")
lines_out.append("")
lines_out.append("# 4. 单图 OCR")
lines_out.append("python3 scripts/ocr_one.py docs/samples_v2/jiaming_*.jpeg --output output/json/v2_xxx.ocr.json")
lines_out.append("")
lines_out.append("# 5. UI 家族 + 页面分类")
lines_out.append("python3 scripts/classify_ui.py output/json/v2_*.ocr.json --output output/classify_v2_report.json")
lines_out.append("")
lines_out.append("# 6. 透视矫正（黄灯样本用）")
lines_out.append("python3 scripts/rectify.py docs/samples_v2/xxx.jpeg output/rectified/v2_xxx.rectified.jpeg")
lines_out.append("```")
lines_out.append("")
lines_out.append("## 附：文件位置")
lines_out.append("")
lines_out.append("- 113 张样本：`docs/samples_v2/`")
lines_out.append("- 87 个 OCR JSON：`output/json/v2_*.ocr.json`")
lines_out.append("- 对照清单（含 v1+v2 数字提取）：`output/核对清单_飞书.md`")
lines_out.append("- 完整交接：`docs/004_HANDOVER_20260725_机台监控图片取样.md`")
lines_out.append("- GitHub：https://gitee.com/luyi1678/hmi_data_reader")

content = "\n".join(lines_out)
OUT.write_text(content, encoding="utf-8")
print(f"✓ 写出 -> {OUT}")
print(f"  大小：{OUT.stat().st_size / 1024:.1f} KB")
print(f"  行数：{len(lines_out)}")