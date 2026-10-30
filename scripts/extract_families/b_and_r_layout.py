"""Physical rows of the supported B&R injection/holding page only."""
from statistics import median

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


def physical_rows(rows, boxes, y_lo, y_hi):
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
    if len(groups) != 3:
        return [[], [], []], [[], [], []]
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
