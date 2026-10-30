"""Logical holding grid for the supported B&R page, after page routing.

Build row/column axes from coordinates first, then associate observations with
their logical intersections. Predictions never become observed rectangles.
This module assigns spatial identities, never parses or corrects process values.
"""
from dataclasses import asdict, dataclass, field
import re
from statistics import median

from .b_and_r_layout import stage_identity

ROWS = ('velocity', 'pressure', 'time')
LABELS = {'速度': 'velocity', '压力': 'pressure', '时间': 'time'}
NUMBER = re.compile(r'(?:\d+\.\d+|\d{3,})')


@dataclass
class Cell:
    section: str
    row_key: str
    stage_id: int
    predicted_bbox: list
    observed_border_ids: list = field(default_factory=list)
    ocr_token_ids: list = field(default_factory=list)
    raw_reading: list = field(default_factory=list)
    ocr_confidences: list = field(default_factory=list)
    stage_identity_verified: bool = False
    mapping_status: str = 'needs_review'
    evidence: list = field(default_factory=list)
    reasons: list = field(default_factory=list)


@dataclass
class LayoutResult:
    profile_id: str = 'b_and_r.injection_holding.multi_stage_position_time'
    section: str = 'holding'
    cells: list = field(default_factory=list)
    column_centers: list = field(default_factory=list)
    column_axis_evidence: dict = field(default_factory=dict)
    row_axes: list = field(default_factory=list)
    observed_borders: dict = field(default_factory=dict)
    ocr_observations: dict = field(default_factory=dict)
    stage_header_ids: list = field(default_factory=list)
    state_evidence: list = field(default_factory=list)
    conflicts: list = field(default_factory=list)
    stage_identity_verified: bool = False
    active_stages: int | None = None


def _center(box):
    return (box[0]+box[2])/2, (box[1]+box[3])/2


def _groups(items, coordinate, tolerance):
    groups = []
    for item in sorted(items, key=coordinate):
        if groups and abs(coordinate(item)-median(coordinate(i) for i in groups[-1])) < tolerance:
            groups[-1].append(item)
        else:
            groups.append([item])
    return groups


def _slope(points):
    xs, ys = zip(*points)
    mx, my = sum(xs)/len(xs), sum(ys)/len(ys)
    denominator = sum((x-mx)**2 for x in xs)
    return sum((x-mx)*(y-my) for x, y in points)/denominator if denominator else 0.


def _ink_present(gray, box):
    if gray is None:
        return False
    x0, y0, x1, y1 = map(round, box)
    patch = gray[max(0, y0):min(gray.shape[0], y1), max(0, x0):min(gray.shape[1], x1)]
    return bool(patch.size and patch.max() > patch.min())


def build_holding_layout(tokens, boxes, title_y, end_y, size, gray, reference=None):
    """Return per-cell raw evidence and verified mappings, including missing cells.

    title_y/end_y are section-local limits in image pixels. The caller supplies
    only an independently verified sibling's stage-one rectangle as reference.
    Row keys follow this profile's three ordered rows, checked against any labels.
    Column identities need consistent printed numbering or the sibling reference.
    """
    result = LayoutResult()
    indexed = [(f'ocr-{i}', t) for i, t in enumerate(tokens)]
    local = [(tid, t) for tid, t in indexed if t.get('bbox')
             and title_y < _center(t['bbox'])[1] < end_y]
    result.ocr_observations = {tid: dict(text=t['text'], confidence=t.get('conf', 0), bbox=t['bbox'],
                                       line_index=t.get('line_index'))
                               for tid, t in local}
    labels = [(tid, t) for tid, t in local if t['text'].strip() in LABELS]
    text_height = median(t['bbox'][3]-t['bbox'][1] for _, t in local) if local else 0
    if not text_height:
        result.conflicts.append('NO_SECTION_OBSERVATIONS')
        return result, [[], [], []]
    borders = [(f'border-{i}', b) for i, b in enumerate(boxes)
               if title_y+1.5*text_height < _center(b)[1] < end_y]
    left = (max(t['bbox'][2] for _, t in labels)+text_height if labels
            else min((b[0] for _, b in borders), default=size[0]))
    numbers = [(tid, t) for tid, t in local if NUMBER.fullmatch(t['text'].strip())
               and _center(t['bbox'])[0] > left
               and _center(t['bbox'])[1] > title_y+1.5*text_height]
    if not numbers and not borders:
        result.conflicts.append('NO_ROW_COLUMN_OBSERVATIONS')
        return result, [[], [], []]
    # Fit shared local skew without using any numeric value or enabled state.
    numeric_rows = _groups(numbers, lambda item: _center(item[1]['bbox'])[1], text_height*1.2)
    slopes = [_slope([_center(t['bbox']) for _, t in row]) for row in numeric_rows if len(row) >= 2]
    if not numbers:
        typical_height = median(b[3]-b[1] for _, b in borders)
        borders = [(bid, b) for bid, b in borders if b[3]-b[1] >= typical_height*.8]
    if not slopes and borders:
        border_rows = _groups(borders, lambda item: _center(item[1])[1],
                              median(b[3]-b[1] for _, b in borders)*.5)
        slopes = [_slope([_center(b) for _, b in row]) for row in border_rows if len(row) >= 2]
    slope = median(slopes) if slopes else 0.
    first_row = (min(_center(t['bbox'])[1]-slope*_center(t['bbox'])[0] for _, t in numbers+labels)
                 if numbers else min(_center(b)[1]-slope*_center(b)[0] for _, b in borders))
    # Stage-heading rectangles are observations too, but lie above the value
    # rows. Select by the local text axes, not by a screen-relative y window.
    borders = [(bid, b) for bid, b in borders
               if _center(b)[1]-slope*_center(b)[0] >= first_row-text_height*.5]
    observations = [dict(kind='ocr', id=tid, box=t['bbox'], token=t) for tid, t in numbers]
    observations += [dict(kind='border', id=bid, box=b) for bid, b in borders if b[0] >= left]
    observations += [dict(kind='label', id=tid, box=t['bbox'], row=LABELS[t['text'].strip()])
                     for tid, t in labels]
    projected = lambda item: _center(item['box'])[1]-slope*_center(item['box'])[0]
    height = median(b[3]-b[1] for _, b in borders) if borders else text_height*2
    groups = _groups(observations, projected, max(text_height*1.2, height*.45))
    if len(groups) != 3:
        result.conflicts.append('ROW_AXIS_AMBIGUOUS')
        return result, [[], [], []]
    for key, group in zip(ROWS, groups):
        conflicts = [o['id'] for o in group if o['kind'] == 'label' and o['row'] != key]
        result.row_axes.append(dict(row_key=key, slope=slope,
            intercept=median(projected(o) for o in group),
            label_ids=[o['id'] for o in group if o['kind'] == 'label'], conflicts=conflicts))
    speed = [o for o in groups[0] if o['kind'] != 'label']
    widths = [o['box'][2]-o['box'][0] for o in speed if o['kind'] == 'border']
    xs = sorted({_center(o['box'])[0] for o in speed}, reverse=True)
    if len(xs) < 2:
        result.conflicts.append('COLUMN_AXIS_AMBIGUOUS')
        return result, [[], [], []]
    merge = median(widths)*.25 if widths else text_height
    columns = _groups(speed, lambda o: -_center(o['box'])[0], merge)
    centers = [median(_center(o['box'])[0] for o in group) for group in columns]
    if len(centers) < 2:
        result.conflicts.append('COLUMN_AXIS_AMBIGUOUS')
        return result, [[], [], []]
    pitch = min(a-b for a, b in zip(centers, centers[1:]))
    width = median(widths) if widths else pitch*.9
    if not .85*width < pitch < 1.3*width:
        result.conflicts.append('IRREGULAR_COLUMN_AXIS')
        return result, [[], [], []]
    positions = [round((centers[0]-x)/pitch) for x in centers]
    if (any(abs(centers[0]-i*pitch-x) > .2*pitch for i, x in zip(positions, centers))
            or positions[-1] >= 5):
        result.conflicts.append('IRREGULAR_COLUMN_AXIS')
        return result, [[], [], []]
    result.column_centers = [centers[0]-i*pitch for i in range(positions[-1]+1)]
    predicted_speed = [[round(x-width/2), round(result.row_axes[0]['intercept']+slope*x-height/2),
                        round(x+width/2), round(result.row_axes[0]['intercept']+slope*x+height/2)]
                       for x in result.column_centers]
    result.stage_identity_verified = stage_identity(tokens, [predicted_speed], title_y/size[1], size, reference)
    if reference is not None and abs(result.column_centers[0]-_center(reference)[0]) >= .35*width:
        result.stage_identity_verified = False
        result.conflicts.append('SIBLING_COLUMN_CONFLICT')
    result.stage_header_ids = [tid for tid, t in local if t['text'].strip() in {'1', '2', '3', '4', '5'}
                              and t.get('conf', 0) >= .8
                              and _center(t['bbox'])[1] < min(b[1] for b in predicted_speed)]
    result.column_axis_evidence = dict(stage_header_ids=result.stage_header_ids,
                                       reference_bbox=reference,
                                       reference_source='verified_injection_stage_one' if reference else None,
                                       source_ids=[o['id'] for o in speed])
    if not result.stage_identity_verified:
        result.conflicts.append('STAGE_IDENTITY_CONFLICT_OR_MISSING')
    n = len(result.column_centers)-1
    mapped_rows = []
    for key, group, axis in zip(ROWS, groups, result.row_axes):
        count = n+1 if key == 'velocity' else n
        mapped = [None]*count
        cells = []
        for i, x in enumerate(result.column_centers[:count]):
            cy = axis['intercept']+slope*x
            cell = Cell('holding', key, i+1,
                        [round(x-width/2), round(cy-height/2), round(x+width/2), round(cy+height/2)],
                        stage_identity_verified=result.stage_identity_verified)
            cell.evidence = ['ordered_row_axis', 'regular_column_axis']+axis['label_ids']
            cell.evidence += result.stage_header_ids
            if reference is not None:
                cell.evidence.append('verified_sibling_stage_one')
            if axis['conflicts']:
                cell.reasons.append('ROW_LABEL_CONFLICT')
            cells.append(cell)
        assigned = {o['id'] for o in group if o['kind'] == 'ocr'}
        extra_text = [dict(kind='ocr', id=tid, box=t['bbox'], token=t) for tid, t in local
                      if tid not in assigned and any(
                          c.predicted_bbox[0] < _center(t['bbox'])[0] < c.predicted_bbox[2]
                          and c.predicted_bbox[1] < _center(t['bbox'])[1] < c.predicted_bbox[3]
                          for c in cells)]
        for observation in [o for o in group if o['kind'] != 'label']+extra_text:
            x, _ = _center(observation['box'])
            indexes = [i for i, cx in enumerate(result.column_centers[:count]) if abs(cx-x) < .25*pitch]
            if len(indexes) != 1:
                # A visible off-axis box is contrary evidence; never silently skip it.
                for cell in cells:
                    cell.reasons.append('OFF_AXIS_'+observation['kind'].upper())
                continue
            cell = cells[indexes[0]]
            if observation['kind'] == 'border':
                cell.observed_border_ids.append(observation['id'])
                result.observed_borders[observation['id']] = observation['box']
            else:
                t = observation['token']
                cell.ocr_token_ids.append(observation['id'])
                cell.raw_reading.append(t['text'])
                cell.ocr_confidences.append(t.get('conf', 0))
        for i, cell in enumerate(cells):
            if len(cell.ocr_token_ids) != 1:
                cell.reasons.append('OCR_MISSING' if not cell.ocr_token_ids else 'OCR_AMBIGUOUS')
            if len(cell.observed_border_ids) > 1:
                cell.reasons.append('BORDER_AMBIGUOUS')
            if not result.stage_identity_verified:
                cell.reasons.append('STAGE_IDENTITY_UNVERIFIED')
            hits = [o for o in group+extra_text if o['kind'] == 'ocr' and o['id'] in cell.ocr_token_ids]
            if len(hits) == 1 and not _ink_present(gray, hits[0]['box']):
                cell.reasons.append('OCR_IMAGE_EVIDENCE_MISSING')
            if not cell.reasons:
                cell.mapping_status = 'verified'
                mapped[i] = hits[0]['token']
            result.cells.append(cell)
        mapped_rows.append(mapped)
    # Count belongs to page state, not routing. Measured row extents can be
    # borders or jointly labeled OCR coordinates; predicted rectangles alone
    # cannot establish enabled stages. Numeric values are never inspected.
    endpoint = any(c.row_key != 'velocity' and c.stage_id == n and c.observed_border_ids
                   and not any(reason.startswith(('OFF_AXIS', 'ROW_LABEL')) for reason in c.reasons)
                   for c in result.cells)
    joint_extents = all(axis['label_ids'] and any(
        c.row_key == axis['row_key'] and c.stage_id == n and c.mapping_status == 'verified'
        for c in result.cells) for axis in result.row_axes[1:])
    if endpoint:
        result.state_evidence.append('observed_lower_row_extent')
    if joint_extents:
        result.state_evidence.append('two_labeled_ocr_row_extents')
    if result.stage_identity_verified and (endpoint or joint_extents) and not any(a['conflicts'] for a in result.row_axes):
        result.active_stages = n
    else:
        result.conflicts.append('ACTIVE_STAGE_EXTENT_UNVERIFIED')
    return result, mapped_rows


def layout_evidence(layout):
    return asdict(layout)
