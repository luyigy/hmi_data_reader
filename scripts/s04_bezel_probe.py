"""S04 调参脚本 v5：深色表圈轮廓定位显示窗 -> 窗内彩色掩膜分行 -> rec-only。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
RECT = HERE.parent / "output/s04_mold_temp/rectified"

COLOR_MASKS = {
    "white": lambda hsv: cv2.inRange(hsv, (0, 0, 165), (180, 100, 255)),
    "green": lambda hsv: cv2.inRange(hsv, (35, 50, 100), (100, 255, 255)),
    "red": lambda hsv: cv2.inRange(hsv, (0, 60, 110), (14, 255, 255))
    | cv2.inRange(hsv, (160, 60, 110), (180, 255, 255)),
}


def bezels(img):
    """深色近矩形区域（显示屏表圈）候选。"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    ih, iw = img.shape[:2]
    dark = cv2.inRange(hsv, (0, 0, 0), (180, 255, 70))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        area_frac = (w * h) / (iw * ih)
        if not (0.0008 <= area_frac <= 0.08):
            continue
        if not (0.6 <= w / h <= 3.5):
            continue
        # 填充率：表圈应为实心深色块
        if cv2.contourArea(c) < 0.5 * w * h:
            continue
        out.append((x, y, w, h))
    return sorted(out, key=lambda b: b[2] * b[3], reverse=True)[:6]


def main():
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False, use_gpu=False)
    ocr.ocr(np.zeros((100, 100, 3), dtype=np.uint8), cls=False)
    from ocr_variants import _run_rec

    for stem in sys.argv[1:]:
        png = RECT / f"{stem}.png"
        img = cv2.imread(str(png))
        if img is None:
            continue
        ih, iw = img.shape[:2]
        print(f"=== {stem} ({iw}x{ih})")
        for x, y, w, h in bezels(img):
            pad = 4
            crop = img[max(0, y - pad):y + h + pad, max(0, x - pad):x + w + pad]
            chsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
            hits = []
            for color, fn in COLOR_MASKS.items():
                m = fn(chsv)
                if cv2.countNonZero(m) < 30:
                    continue
                # 行合并：水平闭运算把同一行数字连成一个 band
                band = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 25), np.uint8))
                cnts, _ = cv2.findContours(band, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                for c2 in cnts:
                    bx, by, bw, bh = cv2.boundingRect(c2)
                    if bw < 12 or bh < 8 or bw < bh * 0.8:
                        continue
                    sub = crop[max(0, by - 3):by + bh + 3, max(0, bx - 3):bx + bw + 3]
                    msub = m[max(0, by - 3):by + bh + 3, max(0, bx - 3):bx + bw + 3]
                    t1, c1 = _run_rec(ocr, sub)
                    t2, c2 = _run_rec(ocr, cv2.cvtColor(msub, cv2.COLOR_GRAY2BGR))
                    hits.append(f"{color}@({x+bx},{y+by},{bw}x{bh}) c={t1!r}({c1:.2f}) m={t2!r}({c2:.2f})")
            if hits:
                print(f"  bezel ({x},{y},{w}x{h}):")
                for hline in hits:
                    print("    ", hline)


if __name__ == "__main__":
    main()
