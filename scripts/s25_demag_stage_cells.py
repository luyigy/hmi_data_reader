"""037 方案①：DEMAG 多级注射曲线页段表列网格重建（治索引漂移）。

深青（当前段）+ 青蓝（末段）两种可靠掩码定位锚点格 → 在锚点间按 n 等分假设
（n=1..6）用补丁中值亮度验证每格存在性，重建完整列网格 → 逐格 rec-only 识别，
**漏字的格保留空槽位（null 不移位）**。写 <stem>.ocr_stage.json（含空槽）。

用法：python3 scripts/s25_demag_stage_cells.py
"""
import json
import os
import sys
from pathlib import Path

RECT = Path("output/inj_z002_calib/rectified")
SCALE = 4.0


def boxes_by_mask(mask, min_area=300):
    contours, _ = __import__("cv2").findContours(
        mask, __import__("cv2").RETR_EXTERNAL, __import__("cv2").CHAIN_APPROX_SIMPLE)
    cv2 = __import__("cv2")
    out = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if (25 <= w <= 150 and 12 <= h <= 55 and 1.2 <= w / h <= 5.5
                and cv2.contourArea(c) / (w * h) > 0.5):
            out.append((x + w / 2, y + h / 2, w, h))
    return out


def main():
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)
    import cv2
    import numpy as np
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)

    for png in sorted(RECT.glob("*.png")):
        stem = png.stem
        out_path = RECT / f"{stem}.ocr_stage.json"
        if out_path.exists():
            continue
        img = cv2.imread(str(png))
        H, W = img.shape[:2]
        y0, y1 = int(H * 0.55), int(H * 0.80)
        region = img[y0:y1, :]
        hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
        m_navy = cv2.inRange(hsv, (0, 40, 40), (179, 255, 115))
        m_navy = cv2.morphologyEx(m_navy, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        m_cyan = cv2.inRange(hsv, (85, 60, 100), (125, 255, 255))
        m_cyan = cv2.morphologyEx(m_cyan, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        anchors = boxes_by_mask(m_navy) + boxes_by_mask(m_cyan)
        anchors.sort(key=lambda b: (b[1], b[0]))

        lines = []
        # 按行聚类锚点（y 差 < 25px）
        rows = []
        for b in anchors:
            if rows and abs(b[1] - rows[-1][-1][1]) < 25:
                rows[-1].append(b)
            else:
                rows.append([b])
        for row in rows:
            xs = sorted(b[0] for b in row)
            x_first, x_last = xs[0], xs[-1]
            if x_last - x_first < 30:
                continue
            best = None
            for n in range(1, 7):
                step = (x_last - x_first) / n
                if step < 25:
                    break
                pts = [x_first + i * step for i in range(n + 1)]
                present = 0
                for px in pts:
                    xi = int(px)
                    yi = int(np.median([b[1] for b in row]))
                    patch = region[max(0, yi - 8):yi + 9, max(0, xi - 12):xi + 13]
                    if patch.size and np.median(
                            cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)[:, :, 2]) < 178:
                        present += 1
                if best is None or present > best[0]:
                    best = (present, pts, step)
                if present == len(pts):
                    break
            if not best or best[0] < 2:
                continue
            _, pts, step = best
            yi = int(np.median([b[1] for b in row]))
            for px in pts:
                xi = int(px)
                w2, h2 = int(step * 0.38), 20
                crop = region[max(0, yi - h2):yi + h2, max(0, xi - w2):xi + w2]
                text, conf = "", 0.0
                if crop.size:
                    c4 = cv2.resize(crop, None, fx=SCALE, fy=SCALE,
                                    interpolation=cv2.INTER_CUBIC)
                    res = ocr.ocr(c4, det=False, cls=False)
                    if res and res[0] and isinstance(res[0], list) and res[0]:
                        text, conf = res[0][0]
                bx0, bx1 = xi - w2, xi + w2
                by0, by1 = y0 + yi - h2, y0 + yi + h2
                lines.append({"text": str(text).strip(), "conf": float(conf), "bbox": {
                    "points": [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]],
                    "x_min": float(bx0), "y_min": float(by0),
                    "x_max": float(bx1), "y_max": float(by1)},
                    "slot": True})
        out_path.write_text(json.dumps(
            {"filename": png.name, "model": "anchor grid rebuild + paddleocr rec-only (x4)",
             "line_count": len(lines), "lines": lines}, ensure_ascii=False, indent=2))
        print(f"ok {stem}: anchors={len(anchors)} slots={len(lines)} -> {[l['text'] for l in lines]}")


if __name__ == "__main__":
    sys.exit(main())
