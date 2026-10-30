"""Physical rows of the supported B&R injection/holding page only."""
from statistics import median

import cv2

from .visual_cells import tokens_in_cells


def infer_active_stages(rows):
    """Count active stages in this B&R profile's physical three-row table.

    Callers must verify complete cell geometry and printed stage identity first.
    OCR token lists are not physical rows.
    """
    if len(rows) != 3:
        return None
    speed, pressure, third = rows
    n = len(pressure)
    if n < 1 or len(third) != n or len(speed) != n + 1:
        return None
    return n


def _recover_holding_rows(groups, proof):
    """Recover borders from a complete sibling row, never from numeric values.

    Only the aligned pressure/time lattice is eligible. The speed row and its
    stage identity must already be intact. Every missing cell needs a detected
    immediate neighbour, and the other lower row must be complete.
    """
    speed, pressure, third = [sorted(group, reverse=True) for group in groups]
    if not stage_identity(proof['tokens'], [speed], proof['title_y'],
                          proof['size'], proof.get('reference')):
        return groups
    widths = [b[2]-b[0] for b in speed]
    if len(speed) < 3 or max(widths) > 1.3*min(widths):
        return groups
    width = median(widths)
    steps = [(a[0]+a[2]-b[0]-b[2])/2 for a, b in zip(speed, speed[1:])]
    if any(not .85*width < step < 1.3*width for step in steps):
        return groups
    n = len(speed)-1
    lower = [pressure, third]
    if sorted(map(len, lower)) == [n, n]:
        return groups
    complete = [i for i, row in enumerate(lower) if len(row) == n]
    if len(complete) != 1:
        return groups
    source_index = complete[0]
    source, target = lower[source_index], lower[1-source_index]
    if not target or len(target) >= n:
        return groups
    if any(abs(b[0]+b[2]-s[0]-s[2])/2 > .2*width
           for b, s in zip(source, speed)):
        return groups
    matches = {}
    for box in target:
        indexes = [i for i, ref in enumerate(source)
                   if abs(box[0]+box[2]-ref[0]-ref[2])/2 < .2*width
                   and .8 < (box[2]-box[0])/(ref[2]-ref[0]) < 1.2]
        if len(indexes) != 1 or indexes[0] in matches:
            return groups
        matches[indexes[0]] = box
    missing = set(range(n))-matches.keys()
    if any(i-1 not in matches and i+1 not in matches for i in missing):
        return groups
    dx = median((box[0]+box[2]-source[i][0]-source[i][2])/2
                for i, box in matches.items())
    offsets = [(box[1]+box[3]-source[i][1]-source[i][3])/2
               for i, box in matches.items()]
    dy = median(offsets)
    height = median(b[3]-b[1] for b in source)
    if (max(offsets)-min(offsets) > .2*height
            or not .8*height < abs(dy) < 1.6*height
            or (dy > 0) != (source_index == 0)):
        return groups
    recovered = []
    for i in range(n):
        if i in matches:
            recovered.append(matches[i])
            continue
        ref = source[i]
        box = [round(ref[0]+dx), round(ref[1]+dy),
               round(ref[2]+dx), round(ref[3]+dy)]
        recovered.append(box)
        proof.setdefault('reconstructed', []).append(dict(
            row=2-source_index, stage=i+1, bbox=box, reference_bbox=ref,
            neighbour_bboxes=[matches[j] for j in (i-1, i+1) if j in matches],
            basis='verified_speed_identity_and_aligned_sibling_row'))
    lower[1-source_index] = recovered
    return [speed, *lower]


def _four_border_support(gray, box):
    """Measure ink along four predicted edges, excluding cell contents."""
    x0, y0, x1, y1 = box
    margin = max(2, round((y1-y0)*.1))
    if x0-margin < 0 or y0-margin < 0 or x1+margin >= gray.shape[1] or y1+margin >= gray.shape[0]:
        return None
    crop = gray[y0-margin:y1+margin+1, x0-margin:x1+margin+1]
    binary = cv2.adaptiveThreshold(crop, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY_INV, 31, 7)
    width, height = x1-x0, y1-y0
    tx, ty = round(width*.1), round(height*.15)
    strips = [binary[:2*margin+1, margin+tx:margin+width-tx],
              binary[height:height+2*margin+1, margin+tx:margin+width-tx],
              binary[margin+ty:margin+height-ty, :2*margin+1],
              binary[margin+ty:margin+height-ty, width:width+2*margin+1]]
    scores = [float((strip.max(axis=0 if i < 2 else 1) > 0).mean())
              for i, strip in enumerate(strips)]
    return scores if min(scores) >= .85 else None


def _recover_missing_time_row(groups, proof, y_hi):
    """Verify an absent row using stage columns, observed pitch and image edges.

    Requires an intact speed row and at least one aligned pressure neighbour.
    A time-only remaining row is too far from speed to establish row pitch.
    Numeric OCR content is never consulted to create a rectangle.
    """
    speed, pressure = [sorted(group, reverse=True) for group in groups]
    if len(speed) < 3 or not stage_identity(proof['tokens'], [speed], proof['title_y'],
                                           proof['size'], proof.get('reference')):
        return groups
    widths = [b[2]-b[0] for b in speed]
    width = median(widths)
    if max(widths) > 1.3*min(widths) or any(
            not .85*width < (a[0]+a[2]-b[0]-b[2])/2 < 1.3*width
            for a, b in zip(speed, speed[1:])):
        return groups
    n = len(speed)-1
    matches = {}
    for box in pressure:
        indexes = [i for i, ref in enumerate(speed[:n])
                   if abs(box[0]+box[2]-ref[0]-ref[2])/2 < .2*width
                   and .8 < (box[2]-box[0])/(ref[2]-ref[0]) < 1.2]
        if len(indexes) != 1 or indexes[0] in matches:
            return groups
        matches[indexes[0]] = box
    if not matches:
        return groups
    offsets = [(box[1]+box[3]-speed[i][1]-speed[i][3])/2
               for i, box in matches.items()]
    dy = median(offsets)
    dx = median((box[0]+box[2]-speed[i][0]-speed[i][2])/2 for i, box in matches.items())
    height = median(b[3]-b[1] for b in speed)
    if not .8*height < dy < 1.6*height or max(offsets)-min(offsets) > .2*height:
        return groups
    restored, evidence = [], []
    for row in (1, 2):
        cells = []
        for i, ref in enumerate(speed[:n]):
            if row == 1 and i in matches:
                cells.append(matches[i])
                continue
            box = [round(ref[0]+dx), round(ref[1]+row*dy),
                   round(ref[2]+dx), round(ref[3]+row*dy)]
            support = _four_border_support(proof['gray'], box) if box[3] < y_hi else None
            if support is None:
                return groups
            cells.append(box)
            evidence.append(dict(row=row, stage=i+1, bbox=box, reference_bbox=ref,
                                 neighbour_bboxes=list(matches.values()), border_support=support,
                                 basis='verified_stage_lattice_pitch_and_four_image_borders'))
        restored.append(cells)
    proof.setdefault('reconstructed', []).extend(evidence)
    return [speed, *restored]


def physical_rows(rows, boxes, y_lo, y_hi, *, recovery=None):
    """Read three physical input rows, preserving missing/duplicate OCR cells.

    The first numeric input row anchors the table below its stage header. All
    subsequent physical rows are found from borders, even with no OCR in a row.
    B&R position cells are staggered, so each row has its own lattice.
    """
    tokens = [t for row in rows for t in row]
    matched = [b for b in boxes if y_lo < (b[1]+b[3])/2 < y_hi and any(
        t.get('bbox') and b[0] < (t['bbox'][0]+t['bbox'][2])/2 < b[2]
        and b[1] < (t['bbox'][1]+t['bbox'][3])/2 < b[3] for t in tokens)]
    if not matched:
        return [[], [], []], [[], [], []]
    start = min((b[1]+b[3])/2 for b in matched)
    candidates = sorted([b for b in boxes if start <= (b[1]+b[3])/2 < y_hi],
                        key=lambda b: (b[1]+b[3])/2)
    groups = []
    for box in candidates:
        cy = (box[1]+box[3])/2
        if groups and abs(cy-median((b[1]+b[3])/2 for b in groups[-1])) < (box[3]-box[1])*.5:
            groups[-1].append(box)
        else:
            groups.append([box])
    if len(groups) == 2 and recovery is not None and recovery.get('gray') is not None:
        groups = _recover_missing_time_row(groups, recovery, y_hi)
    if len(groups) != 3:
        return [[], [], []], [[], [], []]
    if recovery is not None:
        groups = _recover_holding_rows(groups, recovery)
    aligned, evidence = [], []
    for group in groups:
        cells = sorted(group, reverse=True)
        widths = [b[2]-b[0] for b in cells]
        centers = [(b[0]+b[2])/2 for b in cells]
        steps = [a-b for a,b in zip(centers, centers[1:])]
        regular = (len(cells) >= 1 and max(widths) < 1.3*min(widths)
                   and all(.85*median(widths) < step < 1.3*median(widths) for step in steps))
        if not regular:
            return [[], [], []], [[], [], []]
        aligned.append(tokens_in_cells(tokens, cells))
        evidence.append(cells)
    # Pressure aligns with speed; the position row may be half a cell staggered.
    # Reject a shifted/truncated row even when its cell count happens to fit.
    speed, pressure, third = evidence
    width = median(b[2]-b[0] for b in speed)
    for row, tolerance in ((pressure, .25), (third, .65)):
        offsets = [(b[0]+b[2]-s[0]-s[2])/2 for b, s in zip(row, speed)]
        if (not offsets or any(abs(delta) > tolerance*width for delta in offsets)
                or max(offsets)-min(offsets) > .2*width):
            return [[], [], []], [[], [], []]
    return aligned, evidence


def stage_identity(tokens, rows, title_y, size, reference=None):
    """Verify right-to-left numbering against printed headers or sibling table.

    The sibling table must already have verified stage identity. This guards a
    cropped/missing rightmost cell from silently becoming stage 1.
    """
    if not rows or not rows[0]:
        return False
    w, h = size
    cells = rows[0]
    header_bottom = min(b[1] for b in cells)
    headers = [t for t in tokens if t['text'].strip() in {'1','2','3','4','5'}
               and t.get('conf', 0) >= .8 and title_y*h < t['y']*h < header_bottom]
    verified = []
    for token in headers:
        x = token['x']*w
        matches = [index+1 for index,b in enumerate(cells)
                   if abs(x-(b[0]+b[2])/2) < .4*(b[2]-b[0])]
        if len(matches) == 1:
            if matches[0] != int(token['text']):
                return False
            verified.append(matches[0])
    if verified:
        return len(verified) == len(set(verified))
    if reference:
        right = cells[0]
        return abs(right[0]+right[2]-reference[0]-reference[2])/2 < .35*(right[2]-right[0])
    return False
