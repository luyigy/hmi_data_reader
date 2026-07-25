"""单图 OCR：调用 PaddleOCR，输出结构化 JSON (text, bbox, conf, lines)。

环境注意：网络代理会让 paddleocr 2.7 默认下载模型失败。
本脚本支持手动放置模型到 ~/.paddleocr/whl/{det,rec,cls}/ch_*/ 后离线运行。

用法：
    python scripts/ocr_one.py <image> [--output <out.json>] [--no-cls]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--output", "-o")
    ap.add_argument("--no-cls", action="store_true", help="禁用方向分类")
    ap.add_argument("--lang", default="ch")
    args = ap.parse_args()

    img_path = Path(args.image)
    if not img_path.is_file():
        print(f"[ERROR] not found: {img_path}", file=sys.stderr)
        sys.exit(1)

    # 强制 CPU + 清代理
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)

    from paddleocr import PaddleOCR

    ocr = PaddleOCR(
        use_angle_cls=not args.no_cls,
        lang=args.lang,
        show_log=False,
    )
    result = ocr.ocr(str(img_path), cls=not args.no_cls)

    lines = []
    if result and result[0]:
        for line in result[0]:
            bbox_pts, (text, conf) = line
            # bbox 是 4 顶点 [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
            xs = [p[0] for p in bbox_pts]
            ys = [p[1] for p in bbox_pts]
            lines.append({
                "text": text,
                "conf": float(conf),
                "bbox": {
                    "points": [[float(p[0]), float(p[1])] for p in bbox_pts],
                    "x_min": float(min(xs)),
                    "y_min": float(min(ys)),
                    "x_max": float(max(xs)),
                    "y_max": float(max(ys)),
                },
            })

    out = {
        "filename": img_path.name,
        "path": str(img_path),
        "model": f"paddleocr-2.7.3 (PP-OCRv4 ch, use_angle_cls={not args.no_cls})",
        "line_count": len(lines),
        "lines": lines,
    }

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
        print(f"[ocr_one] {len(lines)} lines -> {args.output}")
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()