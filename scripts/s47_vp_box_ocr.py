"""049 A6：TRD6 V-P切换位置深色框旁车 OCR（白字藏青底，整屏 OCR 漏检）。

对 rectified 目录每图：用既有 ocr.json 的「位置」标签（V-P切换 下方，x<0.3）定位，
裁其右侧深色框区域（x +0.03~+0.20, y -0.03~+0.035），反色+3x 放大跑 PaddleOCR，
输出 {stem}.ocr_vp.json（lines 带归一化坐标与 _src=vp_box，供 extract_fields 并入）。

用法：python3 scripts/s47_vp_box_ocr.py output/inj_z020_calib/rectified
"""
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np


def main(rectified_dir: Path):
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)

    sys.path.insert(0, "scripts")
    from extract_fields import norm_tokens

    for meta_path in sorted(rectified_dir.glob("*.rectify.json")):
        stem = meta_path.name[: -len(".rectify.json")]
        out_path = rectified_dir / f"{stem}.ocr_vp.json"
        if out_path.exists():
            print(f"skip {stem} (exists)")
            continue
        meta = json.loads(meta_path.read_text())
        ocr_path = rectified_dir / f"{stem}.ocr.json"
        img_path = rectified_dir / f"{stem}.png"
        if not ocr_path.is_file() or not img_path.is_file():
            continue
        toks = norm_tokens(json.loads(ocr_path.read_text()), meta["screen_size"])
        pos = [t for t in toks if t["text"] == "位置" and t["x"] < 0.3 and 0.1 < t["y"] < 0.3]
        if not pos:
            print(f"WARN {stem}: 位置 label not found")
            continue
        lab = pos[0]
        w, h = meta["screen_size"]
        x0 = int((lab["x"] + 0.03) * w)
        x1 = int((lab["x"] + 0.20) * w)
        y0 = int(max(0, (lab["y"] - 0.03) * h))
        y1 = int((lab["y"] + 0.035) * h)
        img = cv2.imread(str(img_path))
        crop = img[y0:y1, x0:x1]
        if crop.size == 0:
            print(f"WARN {stem}: empty crop")
            continue
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        # 白字藏青底：亮像素为字
        _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        big = cv2.resize(th, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
        res = ocr.ocr(big, cls=False)
        lines = []
        for block in (res or []):
            for box, (text, conf) in (block or []):
                cx = sum(p[0] for p in box) / 4 / 3 + x0
                cy = sum(p[1] for p in box) / 4 / 3 + y0
                lines.append({
                    "text": text, "conf": float(conf),
                    "bbox": [cx - 0.02 * w, cy - 0.01 * h, cx + 0.02 * w, cy + 0.01 * h],
                    "_src": "vp_box",
                })
        out_path.write_text(json.dumps({"lines": lines}, ensure_ascii=False))
        print(f"ok {stem}: {[(l['text'], round(l['conf'],2)) for l in lines]}")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "output/inj_z020_calib/rectified"))
