"""HMI 图片质量门禁。

输出 JSON 报告，对每张图给出：
- triage: green | yellow | red
- reject_codes: 拒绝原因码列表（来自 docs/002 的硬拒绝集）
- warn_codes: 警告原因码列表（黄灯）
- metrics: 各分项指标
- reshoot_guidance: 给现场操作员的重拍建议

硬拒绝原因码：
DUPLICATE_ATTACHMENT, CROSS_RECORD_DUPLICATE, SCREEN_NOT_FOUND, SCREEN_TOO_SMALL,
SEVERE_GLARE, SEVERE_BLUR, SEVERE_PERSPECTIVE, PAGE_UNKNOWN

警告原因码（黄灯）：
NEEDS_RECTIFICATION, LOW_TEXT_SIZE, MINOR_GLARE, LOW_CLASS_CONFIDENCE

判定策略（保守起步，按实测数据后续校准）：
- 用 OpenCV 检测屏幕区域：四边最长的水平/垂直线 + 暗色矩形估计
- 透视：估计四边形 → 比较最长边比例，长宽比超 1.4 即 SEVERE_PERSPECTIVE
- 反光：高亮区域比例（>230 像素值）
- 模糊：Laplacian 方差
- 屏幕太小：屏幕有效宽度 < 700px

用法：
    python scripts/quality.py <image>... --output <report.json>
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

import cv2
import numpy as np


@dataclass
class QualityMetrics:
    width: int = 0
    height: int = 0
    screen_bbox: tuple[int, int, int, int] | None = None
    screen_area_ratio: float = 0.0
    perspective_ratio: float = 1.0  # 越大越倾斜
    blur_score: float = 0.0  # Laplacian variance
    glare_ratio: float = 0.0  # >230 像素比例
    dark_ratio: float = 0.0


@dataclass
class QualityReport:
    filename: str
    triage: str = "green"  # green | yellow | red
    reject_codes: list[str] = field(default_factory=list)
    warn_codes: list[str] = field(default_factory=list)
    metrics: QualityMetrics = field(default_factory=QualityMetrics)
    reshoot_guidance: list[str] = field(default_factory=list)


# 阈值（保守起步，后续用实测数据校准）
THRESHOLD_SCREEN_MIN_WIDTH = 700
THRESHOLD_SCREEN_MIN_AREA_RATIO = 0.30  # 屏幕至少占图 30%（沙迪克屏占比 21-30%，触发红灯）
THRESHOLD_BLUR_VARIANCE = 30.0
THRESHOLD_GLARE_RATIO = 0.05
THRESHOLD_PERSPECTIVE = 1.30


def detect_screen_bbox(img: np.ndarray) -> tuple[int, int, int, int] | None:
    """用暗色矩形估计屏幕四边，返回 (x, y, w, h)。

    启发式：屏幕通常有黑色边框 + 内部有亮色文本。找最大内部颜色方差的中等暗矩形。
    这里用简化方法：Canny + 形态学找最大轮廓 + 验证长宽比。
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    h, w = gray.shape

    # 边缘
    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    # 取最大外接矩形（不做面积过滤，让 triage() 决定 SCREEN_TOO_SMALL）
    best = None
    best_area = 0
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        area = cw * ch
        # 最低面积 1%（防止噪音框），不做精确过滤
        if area < h * w * 0.01:
            continue
        if cw < 200:  # 太窄的不要
            continue
        aspect = max(cw, ch) / max(1, min(cw, ch))
        if aspect > 4.0:  # 太扁的不要（很可能是边缘）
            continue
        if area > best_area:
            best_area = area
            best = (x, y, cw, ch)
    return best


def order_points(pts: np.ndarray) -> np.ndarray:
    """把 4 个点排序为 [左上, 右上, 右下, 左下]。"""
    pts = np.asarray(pts, dtype=np.float32)
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).ravel()
    return np.array([
        pts[np.argmin(s)],      # 左上：x+y 最小
        pts[np.argmin(diff)],   # 右上：y-x 最小
        pts[np.argmax(s)],      # 右下：x+y 最大
        pts[np.argmax(diff)],   # 左下：y-x 最大
    ], dtype=np.float32)


def detect_screen_corners(img: np.ndarray) -> np.ndarray | None:
    """检测显示屏面板四角，返回 (4,2) 像素坐标 [左上, 右上, 右下, 左下]；失败返回 None。

    启发式：显示屏面板是图中最亮的低饱和区域（浅灰/白），边框与机身明显更暗。
    在缩略图上做 (V>140 且 S<90) 阈值 → 形态学闭/开 → 最大轮廓 →
    approxPolyDP 逼近四边形；逼近不出四点则用 minAreaRect 的旋转矩形四角。

    S4（2026-07-30）新增：供 rectify.py 透视矫正与 compute_perspective_ratio 真实测量复用。
    """
    h, w = img.shape[:2]
    scale = 800 / max(h, w)
    small = cv2.resize(img, (int(w * scale), int(h * scale))) if scale < 1 else img.copy()
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    _, S, V = cv2.split(hsv)
    mask = ((V > 140) & (S < 90)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    sh, sw = mask.shape
    best, best_area = None, 0.0
    for c in contours:
        area = cv2.contourArea(c)
        if area < sh * sw * 0.05:  # 至少占图 5%，防噪声
            continue
        if area > best_area:
            best, best_area = c, area
    if best is None:
        return None

    inv = 1.0 / scale if scale < 1 else 1.0
    peri = cv2.arcLength(best, True)
    approx = cv2.approxPolyDP(best, 0.02 * peri, True)
    if len(approx) == 4:
        quad = approx.reshape(-1, 2).astype(np.float32) * inv
    else:
        quad = cv2.boxPoints(cv2.minAreaRect(best)).astype(np.float32) * inv

    quad = order_points(quad)
    # 基本合理性：四边都 > 100px（原图尺度），长宽比不过分离谱
    widths = [np.linalg.norm(quad[1] - quad[0]), np.linalg.norm(quad[2] - quad[3])]
    heights = [np.linalg.norm(quad[3] - quad[0]), np.linalg.norm(quad[2] - quad[1])]
    if min(widths + heights) < 100:
        return None
    aspect = max(widths) / max(1.0, min(heights))
    if not 0.4 <= aspect <= 4.0:
        return None
    return quad


def compute_perspective_ratio(bbox: tuple[int, int, int, int] | None, gray: np.ndarray,
                              quad: np.ndarray | None = None) -> float:
    """估计屏幕透视畸变程度，>=1.0，越大越倾斜。

    S4 起为真实测量（修正此前"名为透视、实为长宽比罚分"的名不副实问题）：
    有屏幕四角（detect_screen_corners）时取对边长度比
    max(上/下, 下/上, 左/右, 右/左)——正对屏幕拍摄时平行边等长，比值≈1.0；
    斜拍时近大远小，比值增大。

    四角不可得时回退旧启发式：屏幕长宽比偏离 [0.7, 2.5] 罚 1.3；屏幕被图像边
    严重裁切罚 1.5。阈值（THRESHOLD_PERSPECTIVE=1.30）两种口径下语义一致。
    """
    if quad is not None:
        q = order_points(quad)
        top = float(np.linalg.norm(q[1] - q[0]))
        bottom = float(np.linalg.norm(q[2] - q[3]))
        left = float(np.linalg.norm(q[3] - q[0]))
        right = float(np.linalg.norm(q[2] - q[1]))
        ratios = []
        for a, b in ((top, bottom), (left, right)):
            lo, hi = min(a, b), max(a, b)
            if lo > 0:
                ratios.append(hi / lo)
        return max(ratios) if ratios else 1.0

    if bbox is None:
        return 1.0
    x, y, bw, bh = bbox
    # 检查屏幕长宽比是否在合理范围（屏幕本身通常宽 > 高，或接近方形）
    aspect = bw / max(bh, 1)
    # 屏幕长宽比偏离 [0.7, 2.5] -> 罚分
    if 0.7 <= aspect <= 2.5:
        aspect_penalty = 1.0
    else:
        aspect_penalty = 1.3

    # 屏幕被图像边严重裁切（边界外推 > 50px）-> reject
    h, w = gray.shape
    margin = 50
    heavily_clipped = (x < -margin or y < -margin
                       or x + bw > w + margin or y + bh > h + margin)
    if heavily_clipped:
        return 1.5  # 严重

    return aspect_penalty


def compute_blur(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def compute_glare(gray: np.ndarray) -> float:
    high = (gray > 230).sum()
    total = gray.size
    return float(high / total) if total else 0.0


def compute_dark(gray: np.ndarray) -> float:
    low = (gray < 30).sum()
    total = gray.size
    return float(low / total) if total else 0.0


def estimate_text_size(bbox: tuple[int, int, int, int] | None) -> int | None:
    """基于屏幕高度估计最小数字字符像素高度（启发式：屏幕高度的 5%）。"""
    if bbox is None:
        return None
    return int(bbox[3] * 0.05)


def triage(report: QualityReport) -> None:
    m = report.metrics
    tri = "green"
    reshoot = []

    if m.screen_bbox is None:
        report.reject_codes.append("SCREEN_NOT_FOUND")
        tri = "red"
        reshoot.append("请正对屏幕拍摄，四个屏幕边角全部入镜，不要从侧面斜拍。")

    if m.screen_bbox is not None:
        x, y, bw, bh = m.screen_bbox
        if bw < THRESHOLD_SCREEN_MIN_WIDTH:
            report.reject_codes.append("SCREEN_TOO_SMALL")
            tri = "red"
            reshoot.append("请靠近拍摄，让显示屏主体占照片大部分，同时保留完整四边。")
        # 最小数字字符像素
        text_h = estimate_text_size(m.screen_bbox)
        if text_h is not None and text_h < 14:
            report.warn_codes.append("LOW_TEXT_SIZE")
            if tri == "green":
                tri = "yellow"
            reshoot.append("屏幕内的数字太小，请靠近拍摄让数字字符清晰可辨。")

    if m.perspective_ratio > THRESHOLD_PERSPECTIVE:
        report.reject_codes.append("SEVERE_PERSPECTIVE")
        tri = "red"
        reshoot.append("请正对屏幕拍摄，四个屏幕边角全部入镜，不要从侧面斜拍。")
    elif m.perspective_ratio > 1.10:
        report.warn_codes.append("NEEDS_RECTIFICATION")
        if tri == "green":
            tri = "yellow"

    if m.blur_score < THRESHOLD_BLUR_VARIANCE:
        report.reject_codes.append("SEVERE_BLUR")
        tri = "red"
        reshoot.append("画面模糊：请擦净镜头、保持手机稳定，点击屏幕区域对焦后重拍。")

    if m.glare_ratio > 0.15:
        report.reject_codes.append("SEVERE_GLARE")
        tri = "red"
        reshoot.append("反光严重：请调整站位或关闭闪光灯，确保反光不覆盖数字区域。")
    elif m.glare_ratio > 0.05:
        report.warn_codes.append("MINOR_GLARE")
        if tri == "green":
            tri = "yellow"
    elif m.glare_ratio > 0.02:
        report.warn_codes.append("MINOR_GLARE")
        if tri == "green":
            tri = "yellow"

    # 屏幕占比过低
    if m.screen_bbox is not None and m.screen_area_ratio < THRESHOLD_SCREEN_MIN_AREA_RATIO:
        report.reject_codes.append("SCREEN_TOO_SMALL")
        tri = "red"
        reshoot.append("屏幕太小：请靠近拍摄，让显示屏主体占照片大部分。")

    report.triage = tri
    report.reshoot_guidance = reshoot


def assess(image_path: Path) -> QualityReport:
    img = cv2.imread(str(image_path))
    if img is None:
        r = QualityReport(filename=image_path.name)
        r.reject_codes.append("READ_ERROR")
        r.triage = "red"
        r.reshoot_guidance.append("图片无法读取，请重新拍照或检查文件格式。")
        return r
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    bbox = detect_screen_bbox(img)
    quad = detect_screen_corners(img)
    metrics = QualityMetrics(
        width=w,
        height=h,
        screen_bbox=bbox,
        screen_area_ratio=(bbox[2] * bbox[3] / (w * h)) if bbox else 0.0,
        perspective_ratio=compute_perspective_ratio(bbox, gray, quad),
        blur_score=compute_blur(gray),
        glare_ratio=compute_glare(gray),
        dark_ratio=compute_dark(gray),
    )

    r = QualityReport(filename=image_path.name, metrics=metrics)
    triage(r)
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--output", "-o", required=True)
    ap.add_argument("--dedup", help="可选：dedup JSON 路径，把重复文件直接标记为红灯")
    args = ap.parse_args()

    dup_hashes = set()
    if args.dedup:
        dedup_report = json.loads(Path(args.dedup).read_text())
        for grp in dedup_report.get("duplicate_within_record", []):
            dup_hashes.add(grp["sha256"])
        for grp in dedup_report.get("duplicate_across_records", []):
            dup_hashes.add(grp["sha256"])

    reports = []
    counts = {"green": 0, "yellow": 0, "red": 0}
    for img_str in args.images:
        p = Path(img_str)
        if not p.is_file():
            continue
        r = assess(p)
        # 标记重复文件
        if dup_hashes:
            import hashlib
            digest = hashlib.sha256(p.read_bytes()).hexdigest()
            if digest in dup_hashes:
                r.reject_codes.append("DUPLICATE_ATTACHMENT")
                if r.triage == "green":
                    r.triage = "yellow"
                r.reshoot_guidance.append("当前多个字段使用了同一张照片，请分别拍摄并上传对应页面。")
        counts[r.triage] += 1
        reports.append(asdict(r))

    out = {
        "summary": {
            "total": len(reports),
            "green": counts["green"],
            "yellow": counts["yellow"],
            "red": counts["red"],
        },
        "reports": reports,
    }
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"[quality] {len(reports)} images -> green={counts['green']} yellow={counts['yellow']} red={counts['red']}")
    print(f"[quality] report -> {args.output}")


if __name__ == "__main__":
    main()