"""026_PLAN S7c：DEMAG 列顶速率蓝框 HSV 颜色分割 + 单格放大识别（det 层漏检召回）。

基础/CLAHE/条状三路 OCR 对蓝框小数字检出仍不全（且存在 '17'->'1' 截读、'-14' 丢号）。
蓝框 HSV 特征稳定（H~100/S~110，背景 S<20）：HSV 掩膜找轮廓 → 逐格裁剪 4x 放大
→ PaddleOCR rec-only（det=False）识别 → 坐标映射回屏幕像素，覆盖写 <stem>.ocr_rates.json。

用法：python3 scripts/s11_demag_rate_cells.py
"""
import json
import os
import sys
from pathlib import Path

RECT = Path("output/fanuc_demag_calib/rectified")
STRIP_Y0, STRIP_Y1 = 0.10, 0.42
SCALE = 4.0
HSV_LO, HSV_HI = (85, 60, 100), (125, 255, 255)


def main():
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)
    import cv2
    import numpy as np
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)

    for png in sorted(RECT.glob("demag_*.png")):
        stem = png.stem
        img = cv2.imread(str(png))
        H, W = img.shape[:2]
        y0, y1 = int(H * STRIP_Y0), int(H * STRIP_Y1)
        strip = img[y0:y1, :]
        hsv = cv2.cvtColor(strip, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, HSV_LO, HSV_HI)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cells = []
        for c in contours:
            x, y, w, h = cv2.boundingRect(c)
            if 15 <= w <= 150 and 8 <= h <= 70 and 0.8 <= w / h <= 8:
                cells.append((x, y, w, h))
        cells.sort()
        lines = []
        for (x, y, w, h) in cells:
            pad = 3
            crop = strip[max(0, y - pad):y + h + pad, max(0, x - pad):x + w + pad]
            crop = cv2.resize(crop, None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_CUBIC)
            res = ocr.ocr(crop, det=False, cls=False)
            text, conf = ("", 0.0)
            if res and res[0] and isinstance(res[0], list) and res[0]:
                text, conf = res[0][0]
            text = str(text).strip()
            if not text:
                continue
            bx0, bx1 = x - pad, x + w + pad
            by0, by1 = y0 + y - pad, y0 + y + h + pad
            lines.append({"text": text, "conf": float(conf), "bbox": {
                "points": [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]],
                "x_min": float(bx0), "y_min": float(by0),
                "x_max": float(bx1), "y_max": float(by1)}})
        (RECT / f"{stem}.ocr_rates.json").write_text(json.dumps(
            {"filename": png.name, "model": "paddleocr rec-only on HSV rate cells (x4)",
             "line_count": len(lines), "lines": lines}, ensure_ascii=False, indent=2))
        print(f"ok {stem}: cells={len(cells)} -> {[l['text'] for l in lines]}")


if __name__ == "__main__":
    sys.exit(main())
