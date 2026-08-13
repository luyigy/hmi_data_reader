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
import re
import sys
from pathlib import Path

import cv2
import numpy as np

# 模温机数码管数值口径（042 S04）：1-3 位整数可带一位小数；范围由模板 sv_range 门禁
NUM_FULLMATCH = re.compile(r"^\d{1,3}(?:\.\d)?$")


def moire_suppress(img):
    """3x3 高斯低通抑制屏幕网格/摩尔纹（2~3px 周期频段）。原地返回新图。"""
    return cv2.GaussianBlur(img, (3, 3), 0)


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


def _run_rec(ocr, crop) -> tuple[str, float]:
    result = ocr.ocr(cv2.resize(crop, None, fx=6, fy=6,
                                interpolation=cv2.INTER_CUBIC),
                     det=False, cls=False)
    if result and result[0] and isinstance(result[0], list) and result[0]:
        text, conf = result[0][0]
        return str(text).strip(), float(conf)
    return "", 0.0


def _write_cells(out_path: Path, png_path: Path, model: str, lines: list[dict]) -> int:
    out_path.write_text(json.dumps({
        "filename": png_path.name,
        "path": str(png_path),
        "model": model,
        "line_count": len(lines),
        "lines": lines,
    }, ensure_ascii=False, indent=2))
    return len(lines)


def generate_demag_rate_sidecar(ocr, png_path: Path, out_path: Path) -> int:
    """DEMAG 温度页蓝色 control 单格 OCR；只收顶部速率格，不收实际温度格。"""
    img = cv2.imread(str(png_path))
    h, w = img.shape[:2]
    y0, y1 = int(h * 0.10), int(h * 0.42)
    strip = img[y0:y1]
    mask = cv2.inRange(cv2.cvtColor(strip, cv2.COLOR_BGR2HSV),
                       (85, 60, 100), (125, 255, 255))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cells = []
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        cy = (y0 + y + ch / 2) / h
        if 15 <= cw <= 150 and 8 <= ch <= 70 and 0.8 <= cw / ch <= 8 and cy < 0.25:
            cells.append((x, y, cw, ch))
    lines = []
    for x, y, cw, ch in sorted(cells):
        pad = 10
        crop = strip[max(0, y - pad):y + ch + pad,
                     max(0, x - pad):x + cw + pad]
        text, conf = _run_rec(ocr, crop)
        if text:
            lines.append({"text": text, "conf": conf, "_src": "rate_cell", "bbox": {
                "points": [[x, y0 + y], [x + cw, y0 + y],
                           [x + cw, y0 + y + ch], [x, y0 + y + ch]],
                "x_min": float(x), "y_min": float(y0 + y),
                "x_max": float(x + cw), "y_max": float(y0 + y + ch),
            }})
    return _write_cells(out_path, png_path, "paddleocr rec-only DEMAG rate cells", lines)


def generate_fanuc_temperature_cells_sidecar(
        ocr, png_path: Path, out_path: Path, base_lines: list[dict],
        screen_size: list[int]) -> int:
    """FANUC N/B1/B2/B3/H 五列逐格 OCR；结构不完整即不生成。"""
    sw, sh = screen_size
    toks = []
    for line in base_lines:
        box = line["bbox"]
        toks.append({"text": line["text"],
                     "x": (box["x_min"] + box["x_max"]) / 2 / sw,
                     "y": (box["y_min"] + box["y_max"]) / 2 / sh})
    labels = {}
    for name, anchor in (("current", "现在"), ("control", "输出"),
                         ("high", "上限"), ("set", "设定"), ("low", "下限")):
        found = [t for t in toks if t["x"] < 0.25 and anchor in t["text"]]
        if not found:
            return 0
        labels[name] = min(found, key=lambda t: t["y"])

    aliases = {0: {"N"}, 1: {"B1", "BI"}, 2: {"B2", "82"},
               3: {"B3", "83"}, 4: {"H"}}
    points = []
    current_y = labels["current"]["y"]
    for token in toks:
        text = token["text"].strip().upper()
        for index, names in aliases.items():
            if text in names and current_y - 0.12 < token["y"] < current_y:
                points.append((index, token["x"]))
    if len(points) < 2:
        return 0
    mean_i = sum(i for i, _ in points) / len(points)
    mean_x = sum(x for _, x in points) / len(points)
    denom = sum((i - mean_i) ** 2 for i, _ in points)
    spacing = sum((i - mean_i) * (x - mean_x) for i, x in points) / denom
    first_x = mean_x - spacing * mean_i
    if not 0.03 <= spacing <= 0.10:
        return 0
    columns = [first_x + spacing * i for i in range(5)]

    img = cv2.imread(str(png_path))
    ih, iw = img.shape[:2]
    lines = []
    for row, label in labels.items():
        ys = [t["y"] for t in toks
              if columns[0] - spacing / 2 < t["x"] < columns[-1] + spacing / 2
              and label["y"] - 0.005 < t["y"] < label["y"] + 0.035
              and any(ch.isdigit() for ch in t["text"])]
        row_y = sorted(ys)[len(ys) // 2] if ys else label["y"]
        for x in columns:
            dx, dy = 0.48 * spacing, 0.015
            x0, x1 = max(0, int((x - dx) * iw)), min(iw, int((x + dx) * iw))
            y0, y1 = max(0, int((row_y - dy) * ih)), min(ih, int((row_y + dy) * ih))
            crop = img[y0:y1, x0:x1]
            if row == "control":
                crop = cv2.GaussianBlur(crop, (3, 3), 0)
            else:
                gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
                crop = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
            text, conf = _run_rec(ocr, crop)
            if text:
                lines.append({"text": text, "conf": conf, "_src": "fanuc_cell", "bbox": {
                    "points": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                    "x_min": float(x0), "y_min": float(y0),
                    "x_max": float(x1), "y_max": float(y1),
                }})
    return _write_cells(out_path, png_path, "paddleocr rec-only FANUC temperature cells", lines)


def _mt_mask_fns():
    """模温机显示行彩色掩膜（白=E5CC PV / 绿=E5CC SV / 红=调节机双数码管）。"""
    return {
        "white": lambda h: cv2.inRange(h, (0, 0, 165), (180, 100, 255)),
        "green": lambda h: cv2.inRange(h, (35, 50, 100), (100, 255, 255)),
        "red": lambda h: cv2.inRange(h, (0, 60, 110), (14, 255, 255))
        | cv2.inRange(h, (160, 60, 110), (180, 255, 255)),
    }


def _mt_find_bands(img):
    """显示行候选条带：(x0,y0,x1,y1,color)。

    1) 深色表圈轮廓定位显示窗（E5CC 黑表圈、调节机深色显示窗），窗内按
       彩色掩膜水平合并出显示行；
    2) 全图彩色掩膜数字行检测兜底（调节机红色 7 段管两行）。"""
    ih, iw = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    mask_fns = _mt_mask_fns()
    bands: list[tuple[int, int, int, int, str]] = []

    # 1) 深色表圈内的彩色显示行
    dark = cv2.inRange(hsv, (0, 0, 0), (180, 255, 90))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    bezels = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area_frac = (w * h) / (iw * ih)
        if not (0.0005 <= area_frac <= 0.08 and 0.6 <= w / h <= 3.5):
            continue
        if cv2.contourArea(contour) < 0.5 * w * h:
            continue
        bezels.append((x, y, w, h))
    for x, y, w, h in sorted(bezels, key=lambda b: b[2] * b[3], reverse=True)[:6]:
        pad = 4
        crop_hsv = hsv[y:y + h + pad, x:x + w + pad]
        for color, fn_mask in mask_fns.items():
            m = fn_mask(crop_hsv)
            if cv2.countNonZero(m) < 30:
                continue
            band = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 25), np.uint8))
            cnts, _ = cv2.findContours(band, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for c2 in cnts:
                bx, by, bw, bh = cv2.boundingRect(c2)
                if bw < 12 or bh < 8:
                    continue
                bands.append((x + bx, y + by, x + bx + bw, y + by + bh, color))

    # 2) 全图彩色掩膜数字行（7 段管段间闭合 -> 数字组件 -> 同行分组）
    for color, fn_mask in mask_fns.items():
        m = cv2.morphologyEx(fn_mask(hsv), cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        n, _, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        comps = []
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            if not (10 <= h <= 200 and 3 <= w <= 160):
                continue
            if h < w * 0.85:
                continue
            # 填充率窗口：7 段数码管为镂空笔画（约 0.1-0.6），实心圆指示灯
            # （>0.65）不是数字，剔除防 '11'/'0' 噪声行
            if not (0.10 <= area / (w * h) <= 0.65):
                continue
            comps.append((x, y, w, h))
        groups: list[list] = []
        for d in sorted(comps, key=lambda c: c[0]):
            x, y, w, h = d
            cy = y + h / 2
            best = None
            for grp in groups:
                mh = sum(c[3] for c in grp) / len(grp)
                my = sum(c[1] + c[3] / 2 for c in grp) / len(grp)
                right = max(c[0] + c[2] for c in grp)
                if abs(cy - my) < mh * 0.6 and 0.4 <= h / mh <= 2.5 \
                        and 0 < x - right < mh * 4.0:
                    best = grp
                    break
            if best is not None:
                best.append(d)
            else:
                groups.append([d])
        for grp in groups:
            if not (2 <= len(grp) <= 5):
                continue
            x0 = min(c[0] for c in grp)
            y0 = min(c[1] for c in grp)
            x1 = max(c[0] + c[2] for c in grp)
            y1 = max(c[1] + c[3] for c in grp)
            bands.append((x0, y0, x1, y1, color))

    # 去重（IoU > 0.4 视为同一显示行，保留先到的表圈内条带；
    # 行中心相近时保留更宽条带——同显示行的碎 digit 子带让位于完整行）
    kept: list[tuple[int, int, int, int, str]] = []
    for b in sorted(bands, key=lambda b: (b[1], b[0])):
        x0, y0, x1, y1, _ = b
        dup = False
        for idx, k in enumerate(kept):
            ix0, iy0 = max(x0, k[0]), max(y0, k[1])
            ix1, iy1 = min(x1, k[2]), min(y1, k[3])
            inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
            area = (x1 - x0) * (y1 - y0) + (k[2] - k[0]) * (k[3] - k[1]) - inter
            same_row = abs((y0 + y1) / 2 - (k[1] + k[3]) / 2) < max(y1 - y0, k[3] - k[1]) * 0.6
            if (area > 0 and inter / area > 0.4) or same_row:
                if x1 - x0 > k[2] - k[0]:
                    kept[idx] = b
                dup = True
                break
        if not dup:
            kept.append(b)
    # 长宽比门禁：至少约两位数字宽（剔除单 digit 碎片与柱状噪声）
    return [b for b in kept if (b[2] - b[0]) >= (b[3] - b[1]) * 1.15]


def generate_mold_temp_display_sidecar(ocr, image_sources, out_path: Path) -> int:
    """模温机独立设备数码管/LCD 显示行 OCR 旁车（042 S04）。

    模温机/温控器为整机拍摄：rectify 的屏幕角点检测可能把机箱盖等非屏四边形
    当作目标扭曲（实测 mt_rear_B07_fd01ca17 矫正图丢失整个温控器），主 OCR
    对小型数码管漏检率高。本旁车接受多个图像源
    （image_sources = [(路径, src_tag), ...]，通常为 [(矫正图, "mt_cell"),
    (原图, "mt_cell_orig")]），对每个源做显示行检测 + 行裁剪 rec-only：
    每行同时尝试彩色裁剪与同色掩膜裁剪，竖行（照片旋转 90°）双向旋转回退；
    可解析为数值（模块级 NUM_FULLMATCH）的结果优先于仅高置信度噪声文本。

    输出行带 _src=src_tag（提取器按 src 分坐标系聚行，不跨系混合），bbox 为
    相对各源图的 0-1 分数坐标，由 extract_fields 合并时换算到屏幕框架。
    结构/颜色证据不足时输出空 sidecar（0），不参与提取。返回写出行数。
    """
    mask_fns = _mt_mask_fns()
    lines = []
    for image_path, src_tag in image_sources:
        img = cv2.imread(str(image_path))
        if img is None:
            continue
        ih, iw = img.shape[:2]
        if src_tag == "mt_cell_orig":
            # 原图全量 OCR（缩放到长边 2000 与矫正图同量级）：整机照片的小型
            # 数码管在主 OCR（作用于可能扭曲的矫正图）中漏检，原图全量 OCR
            # 实测可召回（042 S04：mt_front_B07_657ff3dd/mt_rear_A11_10af110c
            # 双行均命中）。标 _src="mt_full"，分数坐标，属受信来源。
            scale = 2000 / max(ih, iw)
            small = cv2.resize(img, None, fx=scale, fy=scale) if scale < 1 else img
            tmp = out_path.with_name(out_path.stem + ".full_tmp.png")
            cv2.imwrite(str(tmp), small)
            try:
                full_lines = run_ocr(ocr, tmp)
            finally:
                tmp.unlink(missing_ok=True)
            sh, sw = small.shape[:2]
            for l in full_lines:
                # 全量行不做数字过滤：品牌/面板锚文本（奥兰特精机等）供
                # extract 的模板指纹兜底判族与页面锚点路由使用
                b = l["bbox"]
                lines.append({"text": l["text"], "conf": l["conf"], "_src": "mt_full",
                              "bbox": {
                                  "points": [[px / sw, py / sh] for px, py in b["points"]],
                                  "x_min": b["x_min"] / sw, "y_min": b["y_min"] / sh,
                                  "x_max": b["x_max"] / sw, "y_max": b["y_max"] / sh,
                              }})
        for x0, y0, x1, y1, color in _mt_find_bands(img):
            ph = y1 - y0
            # 小边距裁剪：rec 对上下文敏感，过大边距会把残段/相邻字符卷入
            pad = max(4, int(ph * 0.15))
            cx0, cy0 = max(0, x0 - pad), max(0, y0 - pad)
            cx1, cy1 = min(iw, x1 + pad), min(ih, y1 + pad)
            crop = img[cy0:cy1, cx0:cx1]
            if crop.size == 0:
                continue
            mask_crop = mask_fns[color](cv2.cvtColor(crop, cv2.COLOR_BGR2HSV))
            mask_bgr = cv2.cvtColor(mask_crop, cv2.COLOR_GRAY2BGR)
            attempts = [crop, mask_bgr]
            if ph > (x1 - x0):  # 竖行：照片旋转 90° 回退
                attempts = [
                    cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE),
                    cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE),
                    cv2.rotate(mask_bgr, cv2.ROTATE_90_CLOCKWISE),
                    cv2.rotate(mask_bgr, cv2.ROTATE_90_COUNTERCLOCKWISE),
                ]
            best_text, best_conf = "", 0.0
            fallback_text, fallback_conf = "", 0.0
            for attempt in attempts:
                text, conf = _run_rec(ocr, attempt)
                if NUM_FULLMATCH.match(text):
                    if conf > best_conf:
                        best_text, best_conf = text, conf
                elif conf > fallback_conf:
                    fallback_text, fallback_conf = text, conf
            if not best_text:
                best_text, best_conf = fallback_text, fallback_conf
            if not best_text or not any(ch.isdigit() for ch in best_text):
                continue
            fx0, fy0, fx1, fy1 = x0 / iw, y0 / ih, x1 / iw, y1 / ih
            lines.append({"text": best_text, "conf": best_conf, "_src": src_tag,
                          "bbox": {
                              "points": [[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]],
                              "x_min": fx0, "y_min": fy0,
                              "x_max": fx1, "y_max": fy1,
                          }})
    out_path.write_text(json.dumps({
        "filename": "+".join(p.name for p, _ in image_sources),
        "path": str(image_sources[0][0]) if image_sources else "",
        "model": "paddleocr rec-only mold_temp display cells (042 S04)",
        "coords": "fractional",
        "line_count": len(lines),
        "lines": lines,
    }, ensure_ascii=False, indent=2))
    return len(lines)



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
