"""透视矫正：基于检测到的屏幕四角做透视变换，输出矫正后的屏幕图。

两档检测（S4 扩展，2026-07-30）：
1. 四角分支（首选）：亮色面板阈值（显示屏为浅灰/白色低饱和区域，边框为深色）
   → 最大轮廓 → approxPolyDP 四点 / minAreaRect 兜底 → 透视变换。
2. 矩形分支（回退）：quality.detect_screen_bbox 的轴对齐 bbox 做透视变换。

检测失败：不产出矫正图，返回 ok=False + warning "MANUAL_SCREEN_CONFIRM"
（降级为人工确认屏幕框，由调用方记录并决定是否用原图继续）。

输出：矫正图 + 屏幕尺寸（写入 meta，供模板按 x/screen_width, y/screen_height
归一化坐标提取字段）。

用法：
    python scripts/rectify.py <image> <output_image> [--meta <meta.json>] [--max-size 2000]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import cv2
import numpy as np

# 复用 quality.py 的屏幕检测（四角分支 + 轴对齐 bbox 回退分支）
sys.path.insert(0, str(Path(__file__).parent))
from quality import detect_screen_bbox, detect_screen_corners, order_points  # noqa: E402

# 透视变换后最长边上限（保分辨率利于 OCR，又不让 4K 图拖慢）
DEFAULT_MAX_SIZE = 2000
# 小屏幕放大下限：屏幕最长边低于此值时放大（段号小数字低分辨率识别不足的整改，013 S1）
MIN_OUTPUT_SIZE = 1400
MAX_UPSCALE = 2.0


def warp_to_screen(img: np.ndarray, src_pts: np.ndarray, max_size: int) -> tuple[np.ndarray, list[int]]:
    """按四角做透视变换，输出尺寸 = 屏幕实际边长（最长边封顶 max_size，低于 MIN_OUTPUT_SIZE 则放大）。"""
    src_pts = order_points(src_pts)
    w = (np.linalg.norm(src_pts[1] - src_pts[0]) + np.linalg.norm(src_pts[2] - src_pts[3])) / 2
    h = (np.linalg.norm(src_pts[3] - src_pts[0]) + np.linalg.norm(src_pts[2] - src_pts[1])) / 2
    scale = min(1.0, max_size / max(w, h))
    if max(w, h) < MIN_OUTPUT_SIZE:
        scale = min(MAX_UPSCALE, MIN_OUTPUT_SIZE / max(w, h), max_size / max(w, h))
    new_w, new_h = max(1, int(w * scale)), max(1, int(h * scale))
    dst_pts = np.array([
        [0, 0], [new_w - 1, 0], [new_w - 1, new_h - 1], [0, new_h - 1],
    ], dtype=np.float32)
    M = cv2.getPerspectiveTransform(src_pts, dst_pts)
    interp = cv2.INTER_CUBIC if scale > 1.0 else cv2.INTER_AREA
    return cv2.warpPerspective(img, M, (new_w, new_h), flags=interp), [new_w, new_h]


def rectify(image_path: Path, output_path: Path, meta_path: Path | None = None,
            max_size: int = DEFAULT_MAX_SIZE) -> dict:
    img = cv2.imread(str(image_path))
    if img is None:
        return {"filename": image_path.name, "ok": False, "reason": "READ_ERROR",
                "warnings": ["MANUAL_SCREEN_CONFIRM"]}

    # 首选：四角检测 + 透视矫正（传入 bbox 做子面板防护，083 S05）
    bbox = detect_screen_bbox(img)
    quad = detect_screen_corners(img, bbox)
    if quad is not None:
        rectified, size = warp_to_screen(img, quad, max_size)
        method = "corners"
        src = quad.tolist()
    else:
        # 回退：轴对齐 bbox 分支（原实现）
        if bbox is None:
            return {"filename": image_path.name, "ok": False, "reason": "SCREEN_NOT_FOUND",
                    "warnings": ["MANUAL_SCREEN_CONFIRM"]}
        x, y, w, h = bbox
        src = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
        rectified, size = warp_to_screen(img, np.array(src, dtype=np.float32), max_size)
        method = "bbox_fallback"

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), rectified)

    result = {
        "filename": image_path.name,
        "ok": True,
        "method": method,
        "screen_quad": src,
        "screen_size": size,
        "original_size": [img.shape[1], img.shape[0]],
        "original_sha256": hashlib.sha256(image_path.read_bytes()).hexdigest(),
        "output_path": str(output_path),
        "warnings": [],
    }
    if meta_path is not None:
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("output")
    ap.add_argument("--meta", help="可选：meta JSON（屏幕四角/尺寸/warnings）输出路径")
    ap.add_argument("--max-size", type=int, default=DEFAULT_MAX_SIZE)
    args = ap.parse_args()

    meta = Path(args.meta) if args.meta else None
    result = rectify(Path(args.image), Path(args.output), meta, args.max_size)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
