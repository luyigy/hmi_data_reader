"""Identify the B&R page from a visible injection table, without extracting values.

Only OCR text classes and relative box geometry are used. This module does not
read process values, infer active stages, or call the field extractor. Cropping
away the switch region does not invalidate a complete visible table fingerprint.
"""
import re
from statistics import median

from page_identity import line_box as _box
from .b_and_r_headers import section_headers
from .common import norm_cjk


def assess_page(lines):
    # A complete aligned title chain also identifies the uncropped historical page.
    if section_headers(lines) is not None and any(norm_cjk(l['text']).strip() == '外部信号' for l in lines):
        return dict(matched=True, evidence=['aligned_section_titles_and_external_signal'], missing=[], conflicts=[])
    numeric = re.compile(r'\d+\.\d+')
    tokens = [line for line in lines if _box(line)]
    injections = [line for line in tokens if norm_cjk(line['text']).strip() == '射胶']
    matches = 0
    for title in injections:
        box = _box(title)
        y0 = box[3]
        # Find the four row labels of the injection table; coordinates are relative
        # to the observed title/labels, never to the full photograph dimensions.
        rows = []
        last_y = y0
        for label in ('速度', '压力', '位置', '时间'):
            candidates = [line for line in tokens if norm_cjk(line['text']).strip() == label
                          and _box(line)[1] > last_y and _box(line)[2] < box[0]]
            if not candidates:
                break
            row_label = min(candidates, key=lambda line: _box(line)[1])
            lb = _box(row_label)
            height = lb[3]-lb[1]
            values = [line for line in tokens if numeric.fullmatch(line['text'].strip())
                      and _box(line)[0] > lb[2]
                      and abs((_box(line)[1]+_box(line)[3]-lb[1]-lb[3])/2) <= 1.5*height]
            values.sort(key=lambda line: _box(line)[0], reverse=True)
            if not values:
                break
            centers = [(_box(line)[0]+_box(line)[2])/2 for line in values]
            rows.append((lb, centers))
            last_y = lb[3]
        if len(rows) != 4:
            continue
        speed, pressure, position, actual_time = [row[1] for row in rows]
        if min(map(len, (speed, pressure, position, actual_time))) < 2:
            continue
        steps = [a-b for a, b in zip(speed, speed[1:])]
        pitch = median(steps)
        if min(steps) <= 0 or max(steps) > 1.3*min(steps):
            continue
        # B&R's endpoint and actual-time rows share a half-column stagger.
        if not (sum(any(abs(a-b) < .2*pitch for a in speed) for b in pressure) >= 2
                and sum(any(.25*pitch < a-b < .75*pitch for a in pressure) for b in position) >= 2
                and sum(any(abs(a-b) < .2*pitch for a in position) for b in actual_time) >= 2):
            continue
        units = [norm_cjk(line['text']).strip().lower() for line in tokens
                 if rows[0][0][1] <= _box(line)[1] <= rows[-1][0][3]
                 and _box(line)[0] > max(speed)]
        if '%' in units and 'bar' in units:
            matches += 1
    return dict(matched=matches == 1,
                evidence=['injection_label_order_and_staggered_rows'] if matches else [],
                missing=[] if matches else ['distinctive_injection_table_or_section_chain'],
                conflicts=['multiple_injection_tables'] if matches > 1 else [])


def matches_page(lines):
    return assess_page(lines)['matched']
