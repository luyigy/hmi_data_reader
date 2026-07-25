"""生成核对用飞书文档（Markdown）"""
import json
import re
from pathlib import Path
from datetime import datetime

OUT_DIR = Path("output/json")
REPORT_PATH = Path("output/核对清单_飞书.md")

files = sorted(OUT_DIR.glob("*.ocr.json"), key=lambda p: p.name)


def is_number(s):
    return bool(re.match(r'^-?\d+(\.\d+)?$', s.strip()))


def first_number(s):
    m = re.search(r'-?\d+(\.\d+)?', s)
    return m.group(0) if m else None


lines_out = []
lines_out.append("# HMI OCR 核对清单")
lines_out.append("")
lines_out.append(f"**生成时间**：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
lines_out.append(f"**OCR 引擎**：PaddleOCR 2.7.3 + PP-OCRv4 ch (CPU)")
lines_out.append(f"**样本数**：{len(files)} 张")
lines_out.append("")
lines_out.append("## 用法")
lines_out.append("")
lines_out.append("1. 打开原图（在 `docs/samples/` 或 `output/rectified/`）")
lines_out.append("2. 在图片上找到 OCR 文本对应的位置（看 `bbox x/y`）")
lines_out.append("3. 把真值数字填到每节末尾的 `我的核对:` 框里")
lines_out.append("4. 发现 OCR 错/漏的字段，回填到 `output/accuracy_ground_truth_template.json`")
lines_out.append("")
lines_out.append("**字段说明**：")
lines_out.append("- `y (行)` 是 OCR 文本框在图片中的垂直位置（像素）")
lines_out.append("- `x (列)` 是水平位置（像素）")
lines_out.append("- `conf` 是 PaddleOCR 给出的识别置信度（0-1）")
lines_out.append("- `**数字**` 是 OCR 抽出的纯数字；混合文本（如 `设定°C262.0`）只显示数字部分，原文在最后一列")
lines_out.append("")
lines_out.append("---")
lines_out.append("")

total_nums_overall = 0

for ocr_path in files:
    filename = ocr_path.stem.replace(".ocr", "")
    is_rectified = ".rectified" in filename

    lines_out.append(f"## {filename}")
    lines_out.append("")
    base = filename.replace(".rectified", "")
    lines_out.append(f"**原图位置**：`docs/samples/{base}.jpeg`")
    if is_rectified:
        lines_out.append(f"**矫正图**：`output/rectified/{filename}.jpeg`（建议优先看这张）")
    lines_out.append(f"**OCR 输出**：`output/json/{ocr_path.name}`")
    lines_out.append("")

    r = json.loads(ocr_path.read_text())
    lines = r.get("lines", [])

    numbers = []
    texts = []
    for line in lines:
        text = line["text"].strip()
        bbox = line["bbox"]
        if is_number(text):
            numbers.append({
                "text": text,
                "conf": line["conf"],
                "x": bbox["x_min"],
                "y": bbox["y_min"],
            })
        elif first_number(text):
            numbers.append({
                "text": first_number(text),
                "raw": text,
                "conf": line["conf"],
                "x": bbox["x_min"],
                "y": bbox["y_min"],
                "mixed": True,
            })
        else:
            texts.append({
                "text": text,
                "conf": line["conf"],
                "x": bbox["x_min"],
                "y": bbox["y_min"],
            })

    total_nums_overall += len(numbers)

    lines_out.append(f"### 提取的数字（{len(numbers)} 个，按行排列）")
    lines_out.append("")
    lines_out.append("| y (行) | x (列) | conf | 提取数字 | 原文（含混文本时） |")
    lines_out.append("|---|---|---|---|---|")

    # 按 y 分组（容差 ±15 像素视为同一行）
    by_row = []
    for n in sorted(numbers, key=lambda x: (x["y"], x["x"])):
        placed = False
        for row in by_row:
            if abs(row["y_ref"] - n["y"]) < 15:
                row["items"].append(n)
                placed = True
                break
        if not placed:
            by_row.append({"y_ref": n["y"], "items": [n]})

    for row in by_row:
        y_ref = row["y_ref"]
        for n in sorted(row["items"], key=lambda x: x["x"]):
            raw = n.get("raw", "")
            if n.get("mixed"):
                lines_out.append(f"| {y_ref:.0f} | {n['x']:.0f} | {n['conf']:.2f} | **{n['text']}** | `{raw}` |")
            else:
                lines_out.append(f"| {y_ref:.0f} | {n['x']:.0f} | {n['conf']:.2f} | **{n['text']}** | |")

    lines_out.append("")
    lines_out.append(f"### 文字行（{len(texts)} 个，便于理解上下文）")
    lines_out.append("")
    lines_out.append("| y | x | conf | text |")
    lines_out.append("|---|---|---|---|")
    for t in sorted(texts, key=lambda x: (x["y"], x["x"])):
        lines_out.append(f"| {t['y']:.0f} | {t['x']:.0f} | {t['conf']:.2f} | `{t['text']}` |")

    lines_out.append("")
    lines_out.append("**我的核对（人工看到的真实数字）**：")
    lines_out.append("```")
    lines_out.append("")
    lines_out.append("```")
    lines_out.append("")
    lines_out.append("---")
    lines_out.append("")

content = "\n".join(lines_out)
REPORT_PATH.write_text(content, encoding="utf-8")
print(f"✓ 写出 -> {REPORT_PATH}")
print(f"  文件数：{len(files)}")
print(f"  大小：{REPORT_PATH.stat().st_size / 1024:.1f} KB")
print(f"  数字总数：{total_nums_overall}")