"""049 B4：热流道温控箱 SV 弱读格旁车（绿字 LED 眩光截断恢复）。

对 rectified 目录每图：找 SV 行中疑似截断 token（'10.0'/'10'/'9' 等 <150 值），
按格裁切（x±0.05, y±0.025），绿色通道分离（绿字 LED）+4x 放大重 OCR，
输出 {stem}.ocr_hr.json（lines 带归一化坐标与 _src=hr_cell，供 extract_fields 并入）。

用法：python3 scripts/s64_hr_cell_ocr.py output/hr_z023_calib/rectified
"""
import json
import os
import re
import sys
from pathlib import Path

import cv2
import numpy as np

NUM3 = re.compile(r"\d{3}(?:\.\d)?")
WEAK = re.compile(r"^\d{1,2}(?:\.\d)?$")


def _val(text):
    m = NUM3.search(text)
    return float(m.group()) if m else None


def main(rectified_dir: Path):
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)

    for meta_path in sorted(rectified_dir.glob("*.rectify.json")):
        stem = meta_path.name[: -len(".rectify.json")]
        out_path = rectified_dir / f"{stem}.ocr_hr.json"
        if out_path.exists() and len(out_path.read_text()) > 20:
            print(f"skip {stem}")
            continue
        meta = json.loads(meta_path.read_text())
        ocr_path = rectified_dir / f"{stem}.ocr.json"
        img_path = rectified_dir / f"{stem}.png"
        if not ocr_path.is_file() or not img_path.is_file():
            continue
        sys.path.insert(0, "scripts")
        from extract_fields import norm_tokens
        toks = norm_tokens(json.loads(ocr_path.read_text()), meta["screen_size"])
        weak = [t for t in toks
                if WEAK.match(t["text"].strip()) and 0.05 < t["y"] < 0.6]
        if not weak:
            out_path.write_text(json.dumps({"lines": []}))
            print(f"ok {stem}: no weak tokens")
            continue
        w, h = meta["screen_size"]
        img = cv2.imread(str(img_path))
        b, g, r = cv2.split(img.astype(np.int16))
        green = np.clip(g - np.maximum(r, b), 0, 255).astype(np.uint8)
        lines = []
        for t in weak:
            found = None
            for dx, use_th in ((0.05, False), (0.09, False), (0.09, True)):
                x0 = int(max(0, (t["x"] - dx) * w))
                x1 = int(min(w, (t["x"] + dx) * w))
                y0 = int(max(0, (t["y"] - 0.03) * h))
                y1 = int(min(h, (t["y"] + 0.03) * h))
                cell = green[y0:y1, x0:x1]
                if cell.size == 0:
                    continue
                big = cv2.resize(cell, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
                if use_th:
                    _, big = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                res = ocr.ocr(big, cls=False)
                for blk in (res or []):
                    for _, (text, conf) in (blk or []):
                        v = _val(text)
                        if v is not None and 150 <= v <= 500 and conf >= 0.9:
                            if found is None or conf > found[1]:
                                found = (text, conf, v, (x0, y0, x1, y1))
                if found:
                    break
            if found:
                x0, y0, x1, y1 = found[3]
                lines.append({"text": found[0], "conf": float(found[1]),
                              "bbox": {"points": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                                       "x_min": float(x0), "y_min": float(y0),
                                       "x_max": float(x1), "y_max": float(y1)},
                              "_src": "hr_cell"})
        out_path.write_text(json.dumps({"lines": lines}, ensure_ascii=False))
        print(f"ok {stem}: {[(l['text'], round(l['conf'],2)) for l in lines]}")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "output/hr_z023_calib/rectified"))
