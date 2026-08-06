"""OCR 图像预处理变体（034_FIX 新增）。

moire_suppress：屏幕拍照的 LCD 像素网格/刷新摩尔纹在 FFT 上呈 2~3px 周期
竖向主峰（inj_Z002 rank05 实测 2.3px），会让 PaddleOCR 检测把相邻单元格
粘成一个框（'30.090.0'，被数值 fullmatch 过滤而整格丢失）或误读字符。
3x3 高斯低通即可抑制该频段；字符笔画高度约 30px，与条纹频段相差一个
数量级以上，不损伤识别（rank05 段表 8 格全部正确拆分，conf>=0.99）。

变体产物作为**额外合并变体**（<stem>.ocr_moire.json，行标 _src="ocr_variant"
由 extract_fields 并入），只补充 token；同格冲突时主 OCR 值优先
（033_FIX 修复3 机制，demag_injection._dedupe）。主路径输出不变。

用法（批量生成 sidecar，GPU 需外部设 CUDA_VISIBLE_DEVICES/LD_LIBRARY_PATH）：
    .venv/bin/python scripts/ocr_variants.py --rectified-dir output/inj_z002_calib/rectified [stem ...]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import cv2


def moire_suppress(img):
    """3x3 高斯低通抑制屏幕网格/摩尔纹（2~3px 周期频段）。原地返回新图。"""
    return cv2.GaussianBlur(img, (3, 3), 0)


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


def generate_moire_sidecar(ocr, png_path: Path, out_path: Path) -> int:
    """对矫正 PNG 生成摩尔纹抑制变体 OCR sidecar，返回行数。"""
    img = cv2.imread(str(png_path))
    tmp = png_path.with_name(png_path.stem + ".moire_tmp.png")
    cv2.imwrite(str(tmp), moire_suppress(img))
    try:
        lines = run_ocr(ocr, tmp)
    finally:
        tmp.unlink(missing_ok=True)
    out = {
        "filename": png_path.name,
        "path": str(png_path),
        "model": "paddleocr-2.7.3 +moire_suppress(gauss3) variant (034_FIX)",
        "line_count": len(lines),
        "lines": lines,
    }
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    return len(lines)


def main():
    ap = argparse.ArgumentParser(description="摩尔纹抑制变体 OCR sidecar 批量生成（034_FIX）")
    ap.add_argument("stems", nargs="*", help="只处理这些 stem（缺省处理目录下全部）")
    ap.add_argument("--rectified-dir", required=True)
    args = ap.parse_args()

    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False,
                    use_gpu=os.environ.get("CUDA_VISIBLE_DEVICES", "") != "")

    rect_dir = Path(args.rectified_dir)
    stems = args.stems or sorted(p.name[:-4] for p in rect_dir.glob("*.png"))
    for stem in stems:
        png = rect_dir / f"{stem}.png"
        if not png.is_file():
            print(f"[ocr_variants] skip {stem}: 无矫正 PNG")
            continue
        out_path = rect_dir / f"{stem}.ocr_moire.json"
        n = generate_moire_sidecar(ocr, png, out_path)
        print(f"[ocr_variants] {stem}: {n} lines -> {out_path}")


if __name__ == "__main__":
    main()
