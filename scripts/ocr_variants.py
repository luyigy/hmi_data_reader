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
