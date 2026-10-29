"""Brand-neutral bordered-cell geometry and image-only glyph evidence.

Input boxes and output boxes use image pixels. No stage or enable semantics live here.
Supported cells have closed, near-horizontal rectangular borders after rectification.
"""
import cv2
import numpy as np

from .common import bbox_grayscale_contrast


def bordered_cells(gray):
    if gray is None or gray.ndim != 2:
        return []
    h, w = gray.shape
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY_INV, 31, 7)
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        if (.06*w < width < .25*w and .012*h < height < .06*h
                and 2 < width/height < 5 and cv2.contourArea(contour) > .8*width*height):
            boxes.append([x, y, x+width, y+height])
    # Inner and outer border contours describe the same physical cell.
    boxes.sort(key=lambda b: (b[2]-b[0])*(b[3]-b[1]))
    result = []
    for box in boxes:
        if not any(abs(box[0]+box[2]-b[0]-b[2])/2 < .02*w
                   and abs(box[1]+box[3]-b[1]-b[3])/2 < .01*h for b in result):
            result.append(box)
    return result


def cell_glyph_evidence(gray, box):
    """Find central text components without OCR, excluding the cell border.

    Return no evidence when ink cannot be separated from the background. This is
    a contrast measurement, not an enabled/disabled classifier.
    """
    x0, y0, x1, y1 = box
    dx, dy = x1-x0, y1-y0
    left, top = int(x0+.2*dx), int(y0+.2*dy)
    patch = gray[top:int(y1-.2*dy), left:int(x1-.2*dx)]
    if patch.size == 0 or np.ptp(patch) == 0:
        return None
    _, ink = cv2.threshold(patch, 0, 255, cv2.THRESH_BINARY_INV+cv2.THRESH_OTSU)
    _, _, stats, _ = cv2.connectedComponentsWithStats(ink)
    parts = [s for s in stats[1:] if s[4] >= max(3, patch.size*.003)
             and s[3] >= patch.shape[0]*.25]
    if not parts:
        return None
    glyph = [left+min(s[0] for s in parts), top+min(s[1] for s in parts),
             left+max(s[0]+s[2] for s in parts), top+max(s[1]+s[3] for s in parts)]
    glyph = [int(value) for value in glyph]
    contrast = bbox_grayscale_contrast(gray, glyph)
    return dict(bbox=box, glyph_bbox=glyph, contrast=contrast)


def tokens_in_cells(tokens, cells):
    """Keep empty and ambiguous cells explicit, without compacting later values."""
    result = []
    for x0, y0, x1, y1 in cells:
        hits = [t for t in tokens if t.get('bbox') is not None
                and x0 < (t['bbox'][0]+t['bbox'][2])/2 < x1
                and y0 < (t['bbox'][1]+t['bbox'][3])/2 < y1]
        result.append(hits[0] if len(hits) == 1 else None)
    return result
