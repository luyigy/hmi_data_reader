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

from extract_families.common import _affine_fit_columns, _anchor_match  # noqa: E402  # 083 S03 网格旁车锚点复用

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


def _run_rec(ocr, crop, scale=6) -> tuple[str, float]:
    result = ocr.ocr(cv2.resize(crop, None, fx=scale, fy=scale,
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
    """DEMAG 温度页蓝色 control 单格 OCR；只收顶部速率格，不收实际温度格。

    083 S10：读取由裸 rec-only 升级为 _gated_cell_num 三读门禁（同逐格重读
    旁车口径）——竖条纹摩尔纹下裸 rec 会把 '5' 读成 '厂S'（低置信被拒致
    RATE_MISSING），并把 '-5' 的负号读丢成 '5'（conf 0.609 过 0.6 门禁成
    错值）；det+摩尔纹抑制三读在 Z002 rank12 五格全部读对（含负号）。"""
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
        text, conf = _gated_cell_num(ocr, crop)
        if text is None:
            # 083 S13（095 S02 B013）：宽边距把屏摄网格边线/摩尔纹卷入裁剪，
            # 单数字速率格三读被系统性压低（实测 Z005 rank18 区2 '7'：pad10
            # 三读 0.25/0.17/空弃格，贴边三读 0.90/0.93/0.93）。补救轮用贴边
            # 裁剪重读，仍由同一三读门禁裁决——门禁本身不放松，弃格照旧弃。
            tight = strip[y:y + ch, x:x + cw]
            if tight.size:
                text, conf = _gated_cell_num(ocr, tight)
        if text is not None:
            lines.append({"text": text, "conf": conf, "_src": "rate_cell", "bbox": {
                "points": [[x, y0 + y], [x + cw, y0 + y],
                           [x + cw, y0 + y + ch], [x, y0 + y + ch]],
                "x_min": float(x), "y_min": float(y0 + y),
                "x_max": float(x + cw), "y_max": float(y0 + y + ch),
            }})
    return _write_cells(out_path, png_path, "paddleocr gated DEMAG rate cells", lines)


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


def _mt_deskew(img):
    """两条大红色显示行角度一致时拉正图片；单行/噪声不触发。"""
    mask = _mt_mask_fns()["red"](cv2.cvtColor(img, cv2.COLOR_BGR2HSV))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    angles = []
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:6]:
        area = cv2.contourArea(contour)
        (_, _), (w, h), angle = cv2.minAreaRect(contour)
        if area < img.shape[0] * img.shape[1] * 0.001 or min(w, h) < 8 \
                or max(w, h) / min(w, h) < 1.5:
            continue
        angle += 90 if w < h else 0
        while angle > 45:
            angle -= 90
        angles.append(angle)
    if len(angles) < 2 or abs(angles[0] - angles[1]) > 5:
        return img
    angle = (angles[0] + angles[1]) / 2
    if abs(angle) < 8:
        return img
    ih, iw = img.shape[:2]
    matrix = cv2.getRotationMatrix2D((iw / 2, ih / 2), angle, 1)
    return cv2.warpAffine(img, matrix, (iw, ih), borderValue=(255, 255, 255))


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
            # 低分辨率图经闭运算后，两位数码管可能合并为一个整行组件；直接
            # 保留横向数字行，后续 rec-only 数值口径与 PV/SV 双行门禁继续过滤。
            if 8 <= h <= 200 and 12 <= w <= 500 and 1.4 <= w / h <= 5.0:
                bands.append((x, y, x + w, y + h, color))
                # 近方形（w/h<2）的合并组件可能只是整行的一部分（如三位数字
                # 拆成"粘连两位+独立一位"），同时参与同行分组以召回完整行。
                if w / h < 2:
                    comps.append((x, y, w, h))
                continue
            if not (10 <= h <= 200 and 3 <= w <= 160):
                continue
            if h < w * 0.85:
                continue
            # 填充率窗口：低分辨率插值会把 7 段管填充率抬到约 0.7，段间闭合
            # 后粘连的两位数字填充率更高；上方长宽比已剔除近圆形指示灯，
            # 保留到 0.90 以召回仍可分开的两位数字。
            if not (0.10 <= area / (w * h) <= 0.90):
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
        img = _mt_deskew(img)
        ih, iw = img.shape[:2]
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
            tight_crop = img[y0:y1, x0:x1]
            attempts = [
                (crop, 6),
                (mask_bgr, 6),
                (cv2.threshold(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), 0, 255,
                               cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1], 6),
                (tight_crop, 10),
            ]
            if ph > (x1 - x0):  # 竖行：照片旋转 90° 回退
                attempts = [
                    (cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE), 6),
                    (cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE), 6),
                    (cv2.rotate(mask_bgr, cv2.ROTATE_90_CLOCKWISE), 6),
                    (cv2.rotate(mask_bgr, cv2.ROTATE_90_COUNTERCLOCKWISE), 6),
                ]
            best_text, best_conf = "", 0.0
            fallback_text, fallback_conf = "", 0.0
            # 足够高的横向 7 段管优先用 Otsu 去掉未点亮残影；结果仍须与原图
            # 独立坐标系交叉一致，单一路径不会直接成为可信字段。
            if ph >= 20 and ph <= x1 - x0:
                preferred_pad = max(pad, int(ph * (0.42 if color == "red" else 0.24)))
                preferred = img[max(0, y0 - preferred_pad):min(ih, y1 + preferred_pad),
                                max(0, x0 - preferred_pad):min(iw, x1 + preferred_pad)]
                preferred = cv2.threshold(cv2.cvtColor(preferred, cv2.COLOR_BGR2GRAY),
                                          0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
                text, conf = _run_rec(ocr, preferred, 8)
                if NUM_FULLMATCH.match(text):
                    best_text, best_conf = text, conf
            if not best_text:
                for attempt, scale in attempts:
                    text, conf = _run_rec(ocr, attempt, scale)
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


# ------------------------------------------------------- 083 S03 温度表逐格重读旁车
# 整机/斜拍照片上基础+CLAHE OCR 仍整格漏读或把同列多格竖向粘成一个 token
# （B&R 灰底表 5 列只读出 2 列；DEMAG 料口列 '505010'/'3023030'）。网格由
# 行标签+数值 x 聚类实测锚定，逐格裁剪 rec-only 重读；产物带 _src 标记
# （demag_cell / br_cell）由 extract_fields 并入，提取器只在主 OCR 缺格或
# 越界时采信（主 OCR 值优先），网格不完整即不生成（返回 0）。

# 逐格数值口径：1-3 位整数可带一位小数、可负（DEMAG 料口速率/温度均可负到 -50）；
# 允许尾缀杂笔（格线/箭头残笔 '50-'/'50—'），但整数部分超 3 位的多格粘连
# 重读（'505010'）不录取
CELL_NUM_LOOSE = re.compile(r"^(-?\d{1,3}(?:\.\d)?)[^\d]")
CELL_NUM_STRICT = re.compile(r"^-?\d{1,3}(?:\.\d)?$")


def _cell_num(text: str) -> str | None:
    """rec 原文 -> 规范数值文本；尾缀杂笔剥除，多格粘连/非数值返回 None。"""
    text = text.strip()
    if CELL_NUM_STRICT.fullmatch(text):
        return text
    m = CELL_NUM_LOOSE.match(text)
    return m.group(1) if m else None

_TEMPLATES_DIR = Path(__file__).resolve().parents[1] / "templates"


def _grid_toks(lines: list[dict], screen_size: list[int]) -> list[dict]:
    """OCR lines -> 屏幕归一化坐标 token（与 extract_fields.norm_tokens 同构）。"""
    w, h = screen_size
    toks = []
    for line in lines:
        box = line["bbox"]
        toks.append({"text": line["text"], "conf": float(line["conf"]),
                     "x": ((box["x_min"] + box["x_max"]) / 2) / w,
                     "y": ((box["y_min"] + box["y_max"]) / 2) / h,
                     "x0": box["x_min"] / w,
                     "x1": box["x_max"] / w})
    return toks


def _plain_num(text: str) -> float | None:
    m = re.fullmatch(r"-?\d+(?:\.\d+)?", text.strip())
    return float(m.group()) if m else None


def _cluster_x(xs: list[float], gap: float) -> list[list[float]]:
    clusters: list[list[float]] = []
    for x in sorted(xs):
        if clusters and x - clusters[-1][-1] <= gap:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    return clusters


def _det_rec(ocr, crop, scale=3) -> tuple[str, float]:
    """检测+识别读单格（先 det 定位数字组再 rec）；多行按 x 序拼接。"""
    up = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    result = ocr.ocr(up, det=True, cls=False)
    if not result or not result[0]:
        return "", 0.0
    items = sorted(((box, text, float(conf)) for box, (text, conf) in result[0]),
                   key=lambda e: min(p[0] for p in e[0]))
    text = "".join(t for _, t, _ in items).strip()
    conf = min(c for _, _, c in items)
    return text, conf


def _gated_cell_num(ocr, crop) -> tuple[str | None, float]:
    """单格三读门禁（083 S03/S04 口径，宁缺不错）：灰底/摩尔纹单元格上 rec-only
    会把格线并成数字（'20.0'->'200'、'30.0'->'300'，实测 7 格全错），det+摩尔纹
    抑制先定位数字组则稳定（同 7 格全对）。录取顺序：det 读 conf>=0.9 且不与任何
    rec 读冲突（或 conf>=0.98 时以 det 为准）；无 det 读时两个 rec 读一致才收，
    单读需 conf>=0.9；其余放弃，留给主 OCR/缺格告警，不写可能错误的值。
    083 S04 补「det 低置信但与唯一 rec 读一致」路径：det<0.9 时原本直接弃格，
    现 det 读与高置信（>=0.9）rec 读一致才收——双独立读一致，严于既有
    「无 det 单 rec>=0.9」路径，不放宽错值风险。
    083 S10 补「det 高置信冲突时另一路 rec 高置信一致」路径：det>=0.9 但与一路
    rec 冲突且未达 0.98 覆盖线时，若另一路 rec 与 det 同值且 conf>=0.9，两路
    独立高置信读数一致优先于单路异议（抑制变体偶发多读前导笔画 '5'->'15'
    不再弃掉 det/raw 双 0.93+ 一致的正确格）。
    083 S11 补「符号冲突专项」：det 高置信负值与 rec 读仅差前导负号时，两路
    rec 是同一识别器对同一格图的读取，对「是否存在细负号笔画」不构成独立
    证据（实测 DEMAG 速率格 '-14'/'-15'/'-5' 均被两路 rec 系统性丢号，det
    先定位含负号数字组再识别，0.977-1.00 全对）；det>=0.95 取 det 负值，
    0.9<=det<0.95 弃格（宁缺不错）——符号冲突格绝不按正值写出（'+14' 掩盖
    冷却 '-14' 属危险错值）。
    返回 (规范数值文本, conf) 或 (None, 0.0)。"""
    raw_text, raw_conf = _run_rec(ocr, crop)
    sup = moire_suppress(crop)
    sup_text, sup_conf = _run_rec(ocr, sup)
    det_text, det_conf = _det_rec(ocr, sup)
    raw_v, sup_v, det_v = (_cell_num(raw_text), _cell_num(sup_text),
                           _cell_num(det_text))
    # det 会把末尾「.0」整段截掉（实测 295.0 -> 295）；两路 rec 对完整小数
    # 独立一致时，不让单路高置信截尾覆盖更完整的共识读数。
    if (raw_v and raw_v == sup_v and det_v
            and "." in raw_v and "." not in det_v
            and raw_v.startswith(det_v + ".")):
        return raw_v, max(raw_conf, sup_conf)
    if det_v and det_conf >= 0.9:
        conflict = any(v and v != det_v for v in (raw_v, sup_v))
        if not conflict or det_conf >= 0.98:
            return det_v, det_conf
        agree_hi = [c for v, c in ((raw_v, raw_conf), (sup_v, sup_conf))
                    if v == det_v and c >= 0.9]
        if agree_hi:
            return det_v, max(det_conf, agree_hi[0])
        # 083 S11 符号冲突专项（见 docstring）：rec 仅差前导负号不构成独立异议
        if det_v.startswith("-") and any(
                v == det_v[1:] for v in (raw_v, sup_v)):
            if det_conf >= 0.95:
                return det_v, det_conf
            return None, 0.0
    if raw_v and sup_v and raw_v == sup_v:
        return raw_v, max(raw_conf, sup_conf)
    if det_v:
        # det 低置信但与唯一存在的 rec 读一致且该 rec 读高置信
        recs = [(v, c) for v, c in ((raw_v, raw_conf), (sup_v, sup_conf)) if v]
        agree = [(v, c) for v, c in recs if v == det_v]
        if len(recs) == len(agree) == 1 and agree[0][1] >= 0.9:
            return det_v, max(det_conf, agree[0][1])
    if not det_v:
        single = [(v, c) for v, c in ((raw_v, raw_conf), (sup_v, sup_conf)) if v]
        if len(single) == 1 and single[0][1] >= 0.9:
            return single[0]
    return None, 0.0


def _rec_grid_cells(ocr, img, col_centers, row_ys, src_name,
                    slope: float = 0.0, slope_x_ref: float | None = None,
                    x_half_frac: float = 0.35,
                    x_half_abs: float | None = None) -> list[dict]:
    """按实测网格逐格重读；只收规范数值（三读门禁见 _gated_cell_num）。

    083 S13：slope 为行 y 随列 x 的线性漂移（透视去斜残余，B&R 竖屏实拍右侧
    各行整体下移实测约 0.026）；非零时按 y_eff = ry + slope*(cx - x_ref)
    逐列修正采样中心，x_ref 缺省取首列中心。x_half_abs 直接指定半窗宽
    （分数坐标）——ZizES 顶箱数码串宽达列距九成（'310.0' 约 170px/216px），
    且末列油温距前一列近、按全列 min 列距取窗会切掉首尾字符
    （'290.2'->'290'、'2.9'->'2'），由调用方按料筒列距中位数给定；
    缺省参数下行为与旧版完全一致。"""
    h, w = img.shape[:2]
    x_gaps = [b - a for a, b in zip(col_centers, col_centers[1:])]
    y_gaps = [b - a for a, b in zip(row_ys, row_ys[1:])]
    if x_half_abs is not None:
        x_half = x_half_abs
    else:
        x_half = x_half_frac * min(x_gaps)
    y_half = 0.4 * min(y_gaps)
    x_ref = col_centers[0] if slope_x_ref is None else slope_x_ref
    lines = []
    for ry in row_ys:
        for cx in col_centers:
            ry_eff = ry + slope * (cx - x_ref)
            x0 = int(max(0, (cx - x_half) * w))
            x1 = int(min(w, (cx + x_half) * w))
            y0 = int(max(0, (ry_eff - y_half) * h))
            y1 = int(min(h, (ry_eff + y_half) * h))
            if x1 - x0 < 8 or y1 - y0 < 8:
                continue
            crop = img[y0:y1, x0:x1]
            text, conf = _gated_cell_num(ocr, crop)
            if text is None:
                continue
            lines.append({"text": text, "conf": conf, "_src": src_name, "bbox": {
                "points": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                "x_min": float(x0), "y_min": float(y0),
                "x_max": float(x1), "y_max": float(y1),
            }})
    return lines


def _band_row_slope(band: list[dict], row_ys: list[float], gap: float) -> float:
    """band 数值 token 的行斜率中位数（083 S13）。

    逐行归属（0.5*gap 窗口）后仅在 ≥2 点且 x 跨度 ≥0.1 的行内最小二乘拟合，
    取各行斜率中位数；行数不足或斜率越出实拍透视合理范围（|k|>0.15）时
    返回 0，退化为平铺采样（旧行为）。"""
    per_row: dict[int, list[dict]] = {}
    for t in band:
        r = min(range(len(row_ys)), key=lambda i: abs(t["y"] - row_ys[i]))
        if abs(t["y"] - row_ys[r]) <= 0.5 * gap:
            per_row.setdefault(r, []).append(t)
    slopes = []
    for toks in per_row.values():
        xs = [t["x"] for t in toks]
        if len(toks) < 2 or max(xs) - min(xs) < 0.1:
            continue
        mx = sum(xs) / len(xs)
        my = sum(t["y"] for t in toks) / len(toks)
        denom = sum((x - mx) ** 2 for x in xs)
        if denom > 1e-6:
            slopes.append(sum((t["x"] - mx) * (t["y"] - my) for t in toks) / denom)
    if not slopes:
        return 0.0
    slopes.sort()
    k = slopes[len(slopes) // 2]
    return k if abs(k) <= 0.15 else 0.0


def _b_and_r_grid(toks, template):
    """B&R 温度表网格：5 行标签（含单缺失均匀行距推断）+ 数值 x 聚类列。

    返回 (col_centers, row_ys, row_slope) 或 None；row_slope 为 band 数值 token
    的逐行拟合斜率（083 S13：透视去斜残余使右侧列各行 y 整体下移，平铺采样
    会切掉右列数字——实测 Z038 竖屏实拍 #3/#4 列逐格全空），供
    _rec_grid_cells 逐列修正采样中心。"""
    anchors = template["row_anchors"]

    def find(keys, xmax=0.35):
        return sorted([t for t in toks if t["x"] < xmax
                       and _anchor_match(keys, t["text"])],
                      key=lambda t: t["y"])

    found = {"current": find(anchors["current"]), "set": find(anchors["set"]),
             "high": find(anchors["high"]), "low": find(anchors["low"]),
             "control": find(anchors["control"])}
    generic = [t for t in find(anchors["high_low_generic"])
               if t not in found["high"] and t not in found["low"]]
    if not found["high"] and generic:
        found["high"] = [generic.pop(0)]
    if not found["low"] and generic:
        found["low"] = [generic.pop(0)]
    row_names = ["current", "set", "high", "low", "control"]
    missing = [n for n in row_names if not found[n]]
    if len(missing) > 1:
        return None
    if missing:
        # 与 extract_families.b_and_r 同一推断口径：行序固定、行距均匀才外推
        present = [(i, found[n][0]["y"]) for i, n in enumerate(row_names) if found[n]]
        pitches = [(y2 - y1) / (j - i) for (i, y1), (j, y2) in zip(present, present[1:])]
        med = sorted(pitches)[len(pitches) // 2]
        if not (len(pitches) >= 2 and med > 0
                and all(0.6 * med <= p <= 1.5 * med for p in pitches)):
            return None
        m_idx = row_names.index(missing[0])
        i0, y0 = min(present, key=lambda e: abs(e[0] - m_idx))
        row_y = {n: found[n][0]["y"] for n in row_names if found[n]}
        row_y[missing[0]] = y0 + (m_idx - i0) * med
    else:
        row_y = {n: found[n][0]["y"] for n in row_names}
    ys = [row_y[n] for n in row_names]
    gap = min(b - a for a, b in zip(ys, ys[1:]))
    band = [t for t in toks if _plain_num(t["text"]) is not None and t["x"] > 0.12
            and not t["text"].strip().startswith("#")
            and ys[0] - 0.75 * gap < t["y"] < ys[-1] + 0.75 * gap]
    # 083 S13：行标签锚在左缘，数据行随透视右倾——用 band 数值 token 的逐行
    # 拟合斜率中位数修正右侧列采样中心（行内混拟合会虚构斜率，实测 Z038 竖屏
    # 实拍 #3/#4 列逐格全空）；token 不足或斜率越界时为 0，退化为旧平铺行为。
    slope = _band_row_slope(band, ys, gap) if band else 0.0
    clusters = _cluster_x([t["x"] for t in band], 0.045)
    if len(clusters) in (5, 6):
        return [sum(c) / len(c) for c in clusters], ys, slope
    # 083 S05：竖屏整机实拍主 OCR 大量漏格、实测列簇不足且无列头锚点时，
    # 用无锚仿射配准兜底（首列须在行标签右缘之右且组合唯一，否则放弃）。
    label_right = max((t.get("x1") or 0.0)
                      for toks_ in found.values() for t in toks_)
    if label_right > 0:
        labels_all = ("NZ", "#1", "#2", "#3", "#4", "#5")
        tpl_centers = [template["layout"]["column_x_centers"][lb] for lb in labels_all]
        fit = _affine_fit_columns([sum(c) / len(c) for c in clusters],
                                  tpl_centers, x_min=label_right)
        if fit is not None:
            return fit[0], ys, slope
    return None


def _demag_grid(toks, template):
    """DEMAG 温度表网格：实际/设定 + 两个「差」行标签，四行数值 x 联合聚类 5 列。

    返回 (col_centers, row_ys, 0.0) 或 None（083 S13 起与 _b_and_r_grid 统一
    三元组；DEMAG 竖屏实拍斜率场景未复现，暂不拟合行斜率）。"""
    anchors = template["row_anchors"]

    def find_label(keys, xmax=0.2, y_lo=0.3, y_hi=0.65):
        cands = [t for t in toks if t["x"] < xmax and y_lo < t["y"] < y_hi
                 and _anchor_match(keys, t["text"])]
        return min(cands, key=lambda t: t["y"]) if cands else None

    cur = find_label(anchors["current"])
    set_ = find_label(anchors["set"])
    devs = sorted([t for t in toks if t["x"] < 0.2 and 0.35 < t["y"] < 0.65
                   and _anchor_match(anchors["high_low_generic"], t["text"])],
                  key=lambda t: t["y"])
    if not (cur and set_) or len(devs) < 2:
        return None
    ys = [cur["y"], set_["y"], devs[0]["y"], devs[1]["y"]]
    gaps = [b - a for a, b in zip(ys, ys[1:])]
    if any(g < 0.015 for g in gaps):
        return None
    gap = min(gaps)
    # 083 S09：左移布局（实拍左缘微裁，喷嘴1 列 x≈0.15）整列被 band 0.2 下界
    # 排除、缺列仿射配准又被 x_min=0.2 否决（拟合首列 0.13<=0.2），救援网格
    # 整组放弃致缺列无法补读。band 下界与配准 x_min 改用行标签右缘（同 B&R
    # 网格口径）——数据列不可能叠在标签列上，标签右缘之左本无合法数据列。
    label_right = max(t.get("x1") or 0.0 for t in [cur, set_, *devs[:2]])
    band = [t for t in toks if (v := _plain_num(t["text"])) is not None
            and abs(v) <= 500 and label_right < t["x"] < 0.97
            and ys[0] - 0.5 * gap < t["y"] < ys[-1] + 0.5 * gap]
    clusters = _cluster_x([t["x"] for t in band], 0.04)
    # 083 S04：表区右缘外散点数字（屏幕边框/侧栏图标，如实拍右缘孤点 '2'）
    # 会形成单成员边缘簇使网格整组失败；只摘右缘单成员簇，左缘与内部簇不动
    # （左缘可能是弱读的真实喷嘴列，内部簇列序不可破坏）。
    while len(clusters) > 5 and len(clusters[-1]) == 1:
        clusters.pop()
    if len(clusters) != 5:
        # 083 S07：蓝底高亮选中列整列漏读导致簇数 3-4 时，用列头 token
        # （含模板登记的 OCR 误读变体）锚定仿射配准出 5 列网格（同
        # extract_families/demag/temperature.py 列头锚定口径），让逐格 rec 补读缺列；
        # 无锚或配准不可信（残差>0.02）则放弃，维持不生成旁车。
        if 3 <= len(clusters) < 5:
            tpl_cols = template["layout_hint"]["column_x_centers"]
            labels_all = list(tpl_cols.keys())
            variants = template.get("column_header_variants") or {}
            centers = [sum(c) / len(c) for c in clusters]
            hdr_anchors = {}
            for i, cx in enumerate(centers):
                best = None
                for t in toks:
                    if t["y"] >= ys[0]:
                        continue
                    for name in labels_all:
                        cands = variants.get(name) or [name]
                        if any(c in t["text"] for c in cands):
                            d = abs(t["x"] - cx)
                            if d < 0.04 and (best is None or d < best[0]):
                                best = (d, name)
                            break
                if best:
                    hdr_anchors[i] = best[1]
            if hdr_anchors:
                fit = _affine_fit_columns(centers, [tpl_cols[n] for n in labels_all],
                                          label_right, hdr_anchors=hdr_anchors,
                                          labels_all=labels_all)
                if fit is not None:
                    return fit[0], ys, 0.0
        return None
    return [sum(c) / len(c) for c in clusters], ys, 0.0


def generate_temperature_cells_sidecar(ocr, png_path: Path, out_path,
                                       family: str, lines: list[dict],
                                       screen_size: list[int],
                                       measured: dict | None = None) -> int:
    """B_AND_R / DEMAG / ZizES 温度页逐格重读旁车（083 S03），返回写入行数。

    family 为 extract 路由已确认的家族（record/机台先验/模板指纹，可能异于
    分类器结果）；网格实测失败或其他家族返回 0 且不写文件。

    083 S13（095 S02 B013）：ZizES 走 measured 实测几何——其数字列头在屏摄
    下常不足（HEADER_DIGITS_INSUFFICIENT）且主 OCR 对红字数码格截尾漏小数位，
    提取器已用油温锚定/模板兜底得到可信列位与行心（extraction_detail），
    直接按该几何逐格重读比重新推导网格稳健。measured 需含
    columns_measured（7 料筒列 + 油温列）/row_centers（current/set/control，
    去斜坐标）/deskew_slope；逐格采样按 y = y2 + k*(x-0.5) 还原像素行心。"""
    if out_path is not None and Path(out_path).exists():
        Path(out_path).unlink()
    if str(family or "").upper() == "ZIZES":
        grid = _zizes_grid_from_measured(measured)
        if grid is None:
            return 0
        col_centers, row_ys, slope, slope_x_ref = grid
        src_name = "zizes_cell"
        # 半窗宽按 7 个料筒列的列距中位数取 0.48——数码串宽达列距九成，
        # 用全列 min 列距（末列油温更近）会切掉首尾字符；相邻窗不重叠。
        barrel_gaps = sorted(b - a for a, b in zip(col_centers[:7],
                                                   col_centers[1:7]))
        x_half_abs = 0.48 * barrel_gaps[len(barrel_gaps) // 2]
    else:
        builders = {"B_AND_R": (_b_and_r_grid, "br_cell", "b_and_r.temperature.json"),
                    "DEMAG": (_demag_grid, "demag_cell", "demag.temperature.json")}
        spec = builders.get(str(family or "").upper())
        if spec is None:
            return 0
        builder, src_name, tpl_name = spec
        template = json.loads((_TEMPLATES_DIR / tpl_name).read_text(encoding="utf-8"))
        grid = builder(_grid_toks(lines, screen_size), template)
        if grid is None:
            return 0
        col_centers, row_ys, slope = grid
        slope_x_ref = None
        x_half_abs = None
    img = cv2.imread(str(png_path))
    lines_out = _rec_grid_cells(ocr, img, col_centers, row_ys, src_name,
                                slope=slope, slope_x_ref=slope_x_ref,
                                x_half_abs=x_half_abs)
    return _write_cells(Path(out_path), png_path,
                        f"paddleocr rec-only {src_name} grid cells (083 S03)", lines_out)


def _zizes_grid_from_measured(measured: dict | None):
    """ZizES 温度页救援网格：直接采用提取器实测几何（083 S13）。

    返回 (col_centers, row_ys, slope, slope_x_ref) 或 None。slope=deskew_slope、
    x_ref=0.5：提取器行心为去斜坐标 y2 = y - k*(x-0.5)，逐列还原像素行心。"""
    if not measured:
        return None
    cols = measured.get("columns_measured")
    rows = measured.get("row_centers") or {}
    k = measured.get("deskew_slope") or 0.0
    if not cols or len(cols) != 8:
        return None
    try:
        row_ys = [rows["current"], rows["set"], rows["control"]]
    except KeyError:
        return None
    if not all(isinstance(v, (int, float)) for v in [*cols, *row_ys, k]):
        return None
    if not (row_ys[0] < row_ys[1] < row_ys[2]):
        return None
    gaps = [b - a for a, b in zip(row_ys, row_ys[1:])]
    if any(g < 0.015 for g in gaps):
        return None
    return [float(c) for c in cols], [float(y) for y in row_ys], float(k), 0.5


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
