"""透视矫正：基于检测到的屏幕 bbox 做仿射矫正，输出裁切/矫正后的图。

TACT/FANUC 黄灯样本需要先矫正再决定是否能跑 OCR 抽取数字。
当前简化实现：从 detect_screen_bbox 返回的矩形做透视变换 → 输出
归一化（最长边对齐到 1000px）的矫正图。

用法：
    python scripts/rectify.py <image> <output_image>
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

# 复用 quality.py 的屏幕检测
sys.path.insert(0, str(Path(__file__).parent))
from quality import detect_screen_bbox  # noqa: E402


def rectify(image_path: Path, output_path: Path) -> dict:
    img = cv2.imread(str(image_path))
    if img is None:
        return {"filename": image_path.name, "ok": False, "reason": "READ_ERROR"}

    bbox = detect_screen_bbox(img)
    if bbox is None:
        return {"filename": image_path.name, "ok": False, "reason": "SCREEN_NOT_FOUND"}

    x, y, w, h = bbox
    src_pts = np.array([
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
    ], dtype=np.float32)

    # 目标尺寸：把屏幕归一化为 1000 像素最长边（保持长宽比）
    target_max = 1000
    if w >= h:
        new_w, new_h = target_max, int(target_max * h / w)
    else:
        new_w, new_h = int(target_max * w / h), target_max

    dst_pts = np.array([
        [0, 0],
        [new_w - 1, 0],
        [new_w - 1, new_h - 1],
        [0, new_h - 1],
    ], dtype=np.float32)

    M = cv2.getPerspectiveTransform(src_pts, dst_pts)
    rectified = cv2.warpPerspective(img, M, (new_w, new_h))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), rectified)

    return {
        "filename": image_path.name,
        "ok": True,
        "src_bbox": bbox,
        "output_path": str(output_path),
        "output_size": [new_w, new_h],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("output")
    args = ap.parse_args()

    result = rectify(Path(args.image), Path(args.output))
    import json
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()