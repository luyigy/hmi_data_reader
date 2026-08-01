"""026_PLAN S7：DEMAG 列顶速率蓝框条状区放大 OCR（基础/CLAHE 两路漏检的召回补充）。

对 output/fanuc_demag_calib/rectified/demag_*.png：裁屏幕顶部速率条（y 0.08~0.40），
2.5x 放大后跑 PaddleOCR，坐标映射回屏幕像素，写 <stem>.ocr_rates.json。
extract_fields 对 DEMAG 按需合并该旁车文件（同 CLAHE 合并的保守规则）。

用法：python3 scripts/s9_demag_rate_strip_ocr.py
"""
import json
import os
import sys
from pathlib import Path

RECT = Path("output/fanuc_demag_calib/rectified")
STRIP_Y0, STRIP_Y1 = 0.08, 0.40
SCALE = 2.5


def main():
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)
    import cv2
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)

    pngs = sorted(RECT.glob("demag_*.png"))
    assert pngs, "无 demag 矫正图"
    for png in pngs:
        stem = png.stem
        out_path = RECT / f"{stem}.ocr_rates.json"
        if out_path.exists():
            print(f"skip {stem}（已存在）")
            continue
        img = cv2.imread(str(png))
        H, W = img.shape[:2]
        strip = img[int(H * STRIP_Y0):int(H * STRIP_Y1), :]
        strip = cv2.resize(strip, None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_CUBIC)
        result = ocr.ocr(strip, cls=False)
        lines = []
        for item in (result[0] if result and result[0] else []):
            pts, (text, conf) = item
            xs = [p[0] / SCALE for p in pts]
            ys = [p[1] / SCALE + H * STRIP_Y0 for p in pts]
            lines.append({"text": text, "conf": float(conf), "bbox": {
                "points": [[x, y] for x, y in zip(xs, ys)],
                "x_min": min(xs), "y_min": min(ys),
                "x_max": max(xs), "y_max": max(ys)}})
        out_path.write_text(json.dumps(
            {"filename": png.name, "model": "paddleocr ch (rate strip x2.5)",
             "line_count": len(lines), "lines": lines}, ensure_ascii=False, indent=2))
        nums = [l["text"] for l in lines if any(c.isdigit() for c in l["text"])]
        print(f"ok {stem}: {len(lines)} tokens, 含数字 {len(nums)}: {nums[:12]}")


if __name__ == "__main__":
    sys.exit(main())
