"""S04 调参脚本 v4：彩色掩膜 + 数字行检测（宽松合并）+ 裁剪 rec + 旋转回退。"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
RECT = HERE.parent / "output/s04_mold_temp/rectified"

MASKS = {
    "white": lambda hsv: cv2.inRange(hsv, (0, 0, 175), (180, 90, 255)),
    "green": lambda hsv: cv2.inRange(hsv, (35, 60, 110), (100, 255, 255)),
    "red": lambda hsv: cv2.inRange(hsv, (0, 70, 120), (12, 255, 255))
    | cv2.inRange(hsv, (165, 70, 120), (180, 255, 255)),
}
NUM_RE = re.compile(r"^\d{1,3}(?:\.\d)?$")


def find_lines(mask: np.ndarray):
    m = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    comps = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if not (10 <= h <= 200 and 3 <= w <= 160):
            continue
        if h < w * 0.85:
            continue
        if area < 0.10 * w * h:
            continue
        comps.append((x, y, w, h))
    lines = []
    for d in sorted(comps, key=lambda c: c[0]):
        x, y, w, h = d
        cy = y + h / 2
        best = None
        for ln in lines:
            mh = sum(c[3] for c in ln) / len(ln)
            my = sum(c[1] + c[3] / 2 for c in ln) / len(ln)
            right = max(c[0] + c[2] for c in ln)
            if abs(cy - my) < mh * 0.6 and 0.4 <= h / mh <= 2.5 and 0 < x - right < mh * 4.0:
                best = ln
                break
        if best is not None:
            best.append(d)
        else:
            lines.append([d])
    out = []
    for ln in lines:
        if not (2 <= len(ln) <= 5):
            continue
        x0 = min(c[0] for c in ln)
        y0 = min(c[1] for c in ln)
        x1 = max(c[0] + c[2] for c in ln)
        y1 = max(c[1] + c[3] for c in ln)
        out.append((x0, y0, x1, y1, len(ln)))
    return out


def rec_both(ocr, crop, mask_crop):
    from ocr_variants import _run_rec
    results = []
    for tag, im in (("color", crop), ("mask", cv2.cvtColor(mask_crop, cv2.COLOR_GRAY2BGR))):
        t, c = _run_rec(ocr, im)
        results.append((tag, t, c))
    return results


def main():
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False, use_gpu=False)
    ocr.ocr(np.zeros((100, 100, 3), dtype=np.uint8), cls=False)
    from ocr_variants import _run_rec  # noqa: F401

    only = sys.argv[1:] or None
    for png in sorted(RECT.glob("*.png")):
        stem = png.stem
        if only and stem not in only:
            continue
        img = cv2.imread(str(png))
        if img is None:
            continue
        ih, iw = img.shape[:2]
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        print(f"=== {stem} ({iw}x{ih})")
        for color, fn in MASKS.items():
            mask = fn(hsv)
            for x0, y0, x1, y1, nd in find_lines(mask):
                ph = y1 - y0
                pad = max(6, int(ph * 0.3))
                cx0, cy0 = max(0, x0 - pad), max(0, y0 - pad)
                cx1, cy1 = min(iw, x1 + pad), min(ih, y1 + pad)
                crop = img[cy0:cy1, cx0:cx1]
                mcrop = mask[cy0:cy1, cx0:cx1]
                if crop.size == 0:
                    continue
                rs = rec_both(ocr, crop, mcrop)
                extra = ""
                if (y1 - y0) > (x1 - x0):  # 竖行：旋转回退
                    for rot_name, rot in (("cw", cv2.ROTATE_90_CLOCKWISE),
                                          ("ccw", cv2.ROTATE_90_COUNTERCLOCKWISE)):
                        t, c = _run_rec(ocr, cv2.rotate(crop, rot))
                        tm, cm = _run_rec(ocr, cv2.cvtColor(
                            cv2.rotate(mcrop, rot), cv2.COLOR_GRAY2BGR))
                        extra += f" | {rot_name}: color={t!r}({c:.2f}) mask={tm!r}({cm:.2f})"
                summ = " ".join(f"{t}={v!r}({c:.2f})" for t, v, c in rs)
                print(f"  {color:5s} n={nd} box=({x0},{y0},{x1-x0}x{ph}) {summ}{extra}")


if __name__ == "__main__":
    main()
