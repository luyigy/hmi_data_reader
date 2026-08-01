"""033_PLAN：TACT 设定温度行（红渐变框）HSV 召回——基础/CLAHE 两路 OCR 整行漏检的补充。

对 output/tact_exp_calib/rectified/*.png 与 output/tact_calib/*.png：HSV 红/橙掩膜
（H 5~30、S>70）找设定行红框轮廓 → 逐格取内框上部白底区 4x 放大 → rec-only 识别
→ 写 <stem>.ocr_setrow.json（extract_fields 对 TACT 带 _src=set_cell 直接并入）。

用法：python3 scripts/s18_tact_setrow_cells.py
"""
import json
import os
import sys
from pathlib import Path

SCALE = 4.0
HSV_LO, HSV_HI = (5, 70, 80), (30, 255, 255)
DIRS = [Path("output/tact_exp_calib/rectified"), Path("output/tact_calib")]


def main():
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)
    import cv2
    import numpy as np
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)

    for d in DIRS:
        if not d.is_dir():
            continue
        for png in sorted(d.glob("*.png")):
            stem = png.stem
            out_path = png.parent / f"{stem}.ocr_setrow.json"
            if out_path.exists():
                continue
            img = cv2.imread(str(png))
            H, W = img.shape[:2]
            y0, y1 = int(H * 0.15), int(H * 0.50)  # 设定行必在列头与现在行之间
            strip = img[y0:y1, :]
            hsv = cv2.cvtColor(strip, cv2.COLOR_BGR2HSV)
            mask = cv2.inRange(hsv, HSV_LO, HSV_HI)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cells = []
            for c in contours:
                x, y, w, h = cv2.boundingRect(c)
                if 25 <= w <= 200 and 12 <= h <= 80 and 1.2 <= w / h <= 6:
                    cells.append((x, y, w, h))
            cells.sort()
            lines = []
            for (x, y, w, h) in cells:
                # 内框白底值区：格子上半中央
                ix0, ix1 = int(x + w * 0.08), int(x + w * 0.92)
                iy0, iy1 = int(y + h * 0.06), int(y + h * 0.62)
                crop = strip[iy0:iy1, ix0:ix1]
                if crop.size == 0:
                    continue
                crop = cv2.resize(crop, None, fx=SCALE, fy=SCALE,
                                  interpolation=cv2.INTER_CUBIC)
                res = ocr.ocr(crop, det=False, cls=False)
                text, conf = ("", 0.0)
                if res and res[0] and isinstance(res[0], list) and res[0]:
                    text, conf = res[0][0]
                text = str(text).strip()
                if not text or not any(ch.isdigit() for ch in text):
                    continue
                bx0, bx1 = x, x + w
                by0, by1 = y0 + y, y0 + y + h
                lines.append({"text": text, "conf": float(conf), "bbox": {
                    "points": [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]],
                    "x_min": float(bx0), "y_min": float(by0),
                    "x_max": float(bx1), "y_max": float(by1)}})
            out_path.write_text(json.dumps(
                {"filename": png.name, "model": "paddleocr rec-only on HSV set-row cells (x4)",
                 "line_count": len(lines), "lines": lines}, ensure_ascii=False, indent=2))
            print(f"ok {stem}: cells={len(cells)} -> {[l['text'] for l in lines]}")


if __name__ == "__main__":
    sys.exit(main())
