"""生成标注图：在原图上画 OCR bbox + 数字 + 置信度。

输出：output/annotated/<原文件名>_annotated.jpeg
每张图 = 原图 + OCR 识别结果可视化，方便人工核对。
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

OCR_DIR = Path("output/json")
OUT_DIR = Path("output/annotated")
OUT_DIR.mkdir(parents=True, exist_ok=True)


def annotate(ocr_json_path: Path) -> Path | None:
    data = json.loads(ocr_json_path.read_text())
    img_path = Path(data["path"])
    if not img_path.exists():
        # v2_*.json 里 path 是 v2 样本目录；原图可能在 docs/samples_v2/，OCR json 里的 path 应当已对
        print(f"  SKIP {ocr_json_path.name}: img not found {img_path}")
        return None

    img = cv2.imread(str(img_path))
    if img is None:
        print(f"  SKIP {ocr_json_path.name}: cv2.imread failed")
        return None

    lines = data.get("lines", [])
    annotated = img.copy()

    # 准备字体（中文支持）
    # cv2.putText 不支持中文，用 QImage+QPainter 路径更复杂。简化方案：
    # - 用纯 ASCII 字符绘制（数字 + bbox）即可
    # - 数字和英文标签用 cv2.putText OK
    # - 中文字段名（如"现在°C"）只画 bbox 不画 label

    for line in lines:
        text = line["text"]
        conf = line["conf"]
        bbox_pts = line["bbox"]["points"]
        pts = np.array(bbox_pts, dtype=np.int32)

        # 颜色：按置信度
        # 高 (>=0.90) 绿, 中 (0.70-0.90) 黄, 低 (<0.70) 红
        if conf >= 0.90:
            color = (0, 200, 0)  # 绿
        elif conf >= 0.70:
            color = (0, 200, 200)  # 黄
        else:
            color = (0, 0, 220)  # 红

        # 画 bbox 框
        cv2.polylines(annotated, [pts], isClosed=True, color=color, thickness=2)

        # 标签（数字用 ASCII OK，中文跳过）
        # bbox 顶点左上角位置
        x_min, y_min = pts[0]
        # 把标签文字截断到 16 字符
        label = text if len(text) <= 16 else text[:14] + ".."

        # 中文字符（含 CJK 范围）跳过 label 文字
        is_cjk = any(0x4e00 <= ord(c) <= 0x9fff for c in label)
        if not is_cjk:
            # 在框上方写 label + conf
            font = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = max(0.4, min(1.0, 8.0 / max(len(label), 1)))
            text_size = cv2.getTextSize(label, font, font_scale, 1)[0]
            # 背景框
            cv2.rectangle(annotated,
                          (x_min, y_min - text_size[1] - 4),
                          (x_min + text_size[0], y_min),
                          color, -1)
            cv2.putText(annotated, label, (x_min, y_min - 2),
                        font, font_scale, (0, 0, 0), 1, cv2.LINE_AA)
        # 否则仅画框，不画 label（中文）

    # 角落加图例
    legend_y = 30
    legend_items = [
        ("conf>=0.90", (0, 200, 0)),
        ("0.70<=conf<0.90", (0, 200, 200)),
        ("conf<0.70", (0, 0, 220)),
    ]
    for txt, c in legend_items:
        cv2.rectangle(annotated, (10, legend_y - 15), (30, legend_y), c, -1)
        cv2.putText(annotated, txt, (35, legend_y - 3),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        legend_y += 25

    # 写文件名标题（左上角）
    title = f"{data['filename'][:60]} ({len(lines)} lines)"
    cv2.rectangle(annotated, (10, 10), (10 + len(title) * 10, 30), (0, 0, 0), -1)
    cv2.putText(annotated, title, (15, 25),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)

    out_path = OUT_DIR / f"{ocr_json_path.stem}_annotated.jpeg"
    cv2.imwrite(str(out_path), annotated, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return out_path


def main():
    files = sorted(OCR_DIR.glob("*.ocr.json"))
    ok = 0
    skip = 0
    for p in files:
        result = annotate(p)
        if result:
            ok += 1
        else:
            skip += 1
    print(f"\n=== 标注生成 ===")
    print(f"成功: {ok}")
    print(f"跳过: {skip}")
    print(f"输出目录: {OUT_DIR}")


if __name__ == "__main__":
    main()