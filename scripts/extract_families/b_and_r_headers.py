"""B&R section titles verified by text, order and shared horizontal alignment."""
from .common import norm_cjk


def _box(line):
    box = line.get('bbox')
    if isinstance(box, dict):
        return [box[key] for key in ('x_min', 'y_min', 'x_max', 'y_max')]
    return box


def section_headers(lines):
    """Allow one substituted switch-title character, never a missing title.

    Return original tokens; neither OCR text nor coordinates are rewritten.
    Curve captions and sidebar buttons cannot establish the aligned title chain.
    """
    titles = {'injection': [], 'holding': [], 'switch': []}
    for line in lines:
        if not _box(line):
            continue
        text = norm_cjk(line['text']).strip()
        if text == '射胶':
            titles['injection'].append(line)
        elif text == '保压':
            titles['holding'].append(line)
        elif len(text) == 4 and sum(a != b for a, b in zip(text, '保压切换')) <= 1:
            confidence = line.get('conf', line.get('confidence', 0))
            if text == '保压切换' or confidence >= .8:
                titles['switch'].append(line)
    matches = []
    for injection in titles['injection']:
        for holding in titles['holding']:
            for switch in titles['switch']:
                boxes = [_box(line) for line in (injection, holding, switch)]
                xs = [(b[0]+b[2])/2 for b in boxes]
                ys = [(b[1]+b[3])/2 for b in boxes]
                height = max(b[3]-b[1] for b in boxes)
                if ys[0] < ys[1] < ys[2] and max(xs)-min(xs) <= 3*height:
                    matches.append(dict(injection=injection, holding=holding, switch=switch))
    return matches[0] if len(matches) == 1 else None
