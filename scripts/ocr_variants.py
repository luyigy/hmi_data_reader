"""Common CLAHE image preprocessing and OCR evidence capture."""
from pathlib import Path
import json
import cv2


def generate_clahe_sidecar(ocr, png_path: Path, out_path: Path) -> int:
    """对矫正 PNG 生成 CLAHE 变体 OCR sidecar（数码管/低对比召回补充），返回行数。

    与 ocr_one.py --clahe-output 同参数（clip3.0, tile8x8），供 service 在
    分类失败的图片上补召回（2026-08-08 热流道温控箱下排数码管漏检）。
    """
    img = cv2.imread(str(png_path))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    tmp = png_path.with_name(png_path.stem + ".clahe_tmp.png")
    cv2.imwrite(str(tmp), clahe.apply(gray))
    try:
        lines = run_ocr(ocr, tmp)
    finally:
        tmp.unlink(missing_ok=True)
    out = {
        "filename": png_path.name,
        "path": str(png_path),
        "model": "paddleocr-2.7.3 +CLAHE(clip3.0,tile8x8) variant",
        "line_count": len(lines),
        "lines": lines,
    }
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    return len(lines)

def run_ocr(ocr, path: Path) -> list[dict]:
    """与 ocr_one.run_ocr 同构的 lines 提取（text/conf/bbox）。"""
    result = ocr.ocr(str(path), cls=False)
    lines = []
    if result and result[0]:
        for box, (text, conf) in result[0]:
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            lines.append({
                "text": text,
                "conf": float(conf),
                "bbox": {
                    "points": [[float(p[0]), float(p[1])] for p in box],
                    "x_min": float(min(xs)),
                    "y_min": float(min(ys)),
                    "x_max": float(max(xs)),
                    "y_max": float(max(ys)),
                },
            })
    return lines
