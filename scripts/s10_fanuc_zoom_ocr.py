"""026_PLAN S7c：FANUC 低质图整屏放大 OCR 变体（rank02 暗图/rank05 大像素/rank06 横屏行漏检召回）。

对 output/fanuc_demag_calib/rectified/fanuc_*.png：整屏 2x 放大跑 PaddleOCR，
坐标映射回屏幕像素，写 <stem>.ocr_zoom.json（extract_fields 对 FANUC 按需合并）。

用法：python3 scripts/s10_fanuc_zoom_ocr.py
"""
import json
import os
import sys
from pathlib import Path

RECT = Path("output/fanuc_demag_calib/rectified")
SCALE = 2.0


def main():
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)
    import cv2
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)

    for png in sorted(RECT.glob("fanuc_*.png")):
        stem = png.stem
        out_path = RECT / f"{stem}.ocr_zoom.json"
        if out_path.exists():
            print(f"skip {stem}")
            continue
        img = cv2.imread(str(png))
        img = cv2.resize(img, None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_CUBIC)
        result = ocr.ocr(img, cls=False)
        lines = []
        for item in (result[0] if result and result[0] else []):
            pts, (text, conf) = item
            xs = [p[0] / SCALE for p in pts]
            ys = [p[1] / SCALE for p in pts]
            lines.append({"text": text, "conf": float(conf), "bbox": {
                "points": [[x, y] for x, y in zip(xs, ys)],
                "x_min": min(xs), "y_min": min(ys),
                "x_max": max(xs), "y_max": max(ys)}})
        out_path.write_text(json.dumps(
            {"filename": png.name, "model": "paddleocr ch (zoom x2)",
             "line_count": len(lines), "lines": lines}, ensure_ascii=False, indent=2))
        print(f"ok {stem}: {len(lines)} tokens")


if __name__ == "__main__":
    sys.exit(main())
