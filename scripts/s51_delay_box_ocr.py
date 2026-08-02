"""049 A7：ARBURG 延迟时间灰框旁车 OCR（左上小灰框，整屏 OCR 漏检）。

对 rectified 目录每图：裁内容区左上（y 0.28~0.42, x 0~0.45），3x 放大跑 PaddleOCR，
输出 {stem}.ocr_delay.json（lines 带归一化坐标与 _src=delay_box，供 extract_fields 并入）。

用法：python3 scripts/s51_delay_box_ocr.py output/inj_z068_calib/rectified
"""
import json
import os
import sys
from pathlib import Path

import cv2


def main(rectified_dir: Path):
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)

    for meta_path in sorted(rectified_dir.glob("*.rectify.json")):
        stem = meta_path.name[: -len(".rectify.json")]
        out_path = rectified_dir / f"{stem}.ocr_delay.json"
        if out_path.exists():
            print(f"skip {stem}")
            continue
        meta = json.loads(meta_path.read_text())
        img_path = rectified_dir / f"{stem}.png"
        if not img_path.is_file():
            continue
        w, h = meta["screen_size"]
        img = cv2.imread(str(img_path))
        crop = img[int(0.28 * h):int(0.42 * h), 0:int(0.45 * w)]
        big = cv2.resize(crop, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
        res = ocr.ocr(big, cls=False)
        lines = []
        for block in (res or []):
            for box, (text, conf) in (block or []):
                cx = (sum(p[0] for p in box) / 4 / 3) / w
                cy = (sum(p[1] for p in box) / 4 / 3 + 0.28 * h) / h
                x0, x1 = (cx - 0.02) * w, (cx + 0.02) * w
                y0, y1 = (cy - 0.01) * h, (cy + 0.01) * h
                lines.append({"text": text, "conf": float(conf),
                              "bbox": {"points": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                                       "x_min": x0, "y_min": y0, "x_max": x1, "y_max": y1},
                              "_src": "delay_box"})
        out_path.write_text(json.dumps({"lines": lines}, ensure_ascii=False))
        print(f"ok {stem}: {[(l['text'], round(l['conf'],2)) for l in lines]}")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "output/inj_z068_calib/rectified"))
