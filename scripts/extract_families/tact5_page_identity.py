"""TACT family blocks and TACT5-specific layout evidence; no process value parsing."""
import re
from statistics import median

from page_identity import line_box as _box


def _labels(lines, pattern):
    found = []
    for line in lines:
        match = re.fullmatch(pattern, line['text'].strip(), re.I)
        box = _box(line)
        if match and box and line.get('conf', line.get('confidence', 0)) >= .8:
            found.append((int(match[1]), (box[0]+box[2])/2, (box[1]+box[3])/2, box[3]-box[1]))
    return sorted(found, key=lambda label: label[1])


def _row(labels, descending=False):
    if len(labels) < 2 or len({l[0] for l in labels}) != len(labels):
        return False
    ids = [l[0] for l in labels]
    if ids != sorted(ids, reverse=descending):
        return False
    return max(l[2] for l in labels)-min(l[2] for l in labels) <= 2*median(l[3] for l in labels)


def assess_page(lines):
    evidence, missing, conflicts = [], [], []
    speed = _labels(lines, r'V(\d+)')
    end = _labels(lines, r'SV(\d+)')
    sm = [l for l in lines if l['text'].strip().upper() == 'SM' and _box(l)]
    if _row(speed, True) and _row(end, True) and len(sm) == 1:
        sx = (_box(sm[0])[0]+_box(sm[0])[2])/2
        if (median(l[2] for l in speed) < median(l[2] for l in end)
                and end[0][1] > speed[0][1] and sx > end[-1][1]):
            evidence.append('nissei_v_sv_sm_staggered_block')
    vs = _labels(lines, r'VS(\d+)')
    pb = _labels(lines, r'PB(\d+)')
    bp = _labels(lines, r'BP(\d+)')
    vsl = _labels(lines, r'VSL(\d+)')
    metering = False
    if _row(vs) and _row(pb) and vsl:
        height = median(l[3] for l in vs+pb)
        aligned = sum(any(v[0] == p[0] and abs(v[1]-p[1]) < 3*height for p in pb) for v in vs)
        metering = (aligned >= 2 and median(l[2] for l in vs) < median(l[2] for l in pb)
                    < median(l[2] for l in vsl) and min(l[1] for l in vs)-height <= vsl[0][1]
                    <= max(l[1] for l in vs)+height)
    if metering:
        evidence.append('tact5_vs_pb_vsl_metering_block')
    if _row(bp):
        conflicts.append('legacy_tact_bp_labels_require_separate_profile')
    if not evidence:
        missing.append('distinctive_nissei_local_block')
    elif not metering:
        missing.append('tact5_generation_discriminator')
    return dict(family='TACT5' if metering and not conflicts else 'NISSEI_TACT_FAMILY',
                matched=metering and not conflicts, evidence=evidence, missing=missing, conflicts=conflicts)
