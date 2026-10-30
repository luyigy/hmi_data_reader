"""Page routing evidence, independent of field extractor registration and execution."""
from importlib import import_module
from math import isfinite


PLUGINS = {
    'b_and_r.injection_holding.multi_stage_position_time':
        (('B_AND_R',), 'b_and_r_page_identity'),
    'tact5.process_settings.injection_holding_metering':
        (('TACT', 'TACT5'), 'tact5_page_identity'),
}


def line_box(line):
    box = line.get('bbox')
    if isinstance(box, dict):
        box = [box.get(key) for key in ('x_min', 'y_min', 'x_max', 'y_max')]
    if (not isinstance(box, (list, tuple)) or len(box) != 4
            or not all(type(v) in (int, float) and isfinite(v) for v in box)
            or box[0] >= box[2] or box[1] >= box[3]):
        return None
    return box


def profile_identity(profile_id, lines, family='unknown'):
    plugin = PLUGINS.get(profile_id)
    if plugin is None:
        return None
    families, module = plugin
    if family != 'unknown' and family not in families:
        return dict(profile_id=profile_id, family=families[-1], matched=False,
                    evidence=[], missing=[], conflicts=['controller_family_conflict'])
    assessment = getattr(import_module('extract_families.' + module), 'assess_page')(lines)
    return {'profile_id': profile_id, 'family': families[-1], **assessment}


def page_identity_match(template, lines):
    assessment = profile_identity(template.get('profile_id'), lines)
    return bool(assessment and assessment['matched'])


def route_identities(lines, family='unknown', profile_ids=None):
    candidates = [profile_identity(pid, lines, family) for pid in (PLUGINS if profile_ids is None else profile_ids)]
    candidates = [c for c in candidates if c is not None and (c['matched'] or c['evidence'])]
    matched = [c for c in candidates if c['matched'] and not c['conflicts']]
    return dict(version='1.0', status='matched' if len(matched) == 1 else 'ambiguous' if matched else 'unknown',
                profile_id=matched[0]['profile_id'] if len(matched) == 1 else None,
                candidates=candidates)
