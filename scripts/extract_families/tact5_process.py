"""TACT5 page observations. Unknown enablement never becomes an active setpoint."""
import re
from collections import Counter

NUMBER = re.compile(r'([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(mm/s|MPa|rpm|mm|s|段)?', re.I)


def extract_tact5(lines, template, meta):
    width, height = meta['screen_size']
    cells = []
    for index, line in enumerate(lines):
        box = line['bbox']
        cells.append(dict(text=line['text'].strip(), confidence=float(line['conf']), index=index,
                          bbox=[box[k] for k in ('x_min', 'y_min', 'x_max', 'y_max')]))

    def center(cell):
        x1, y1, x2, y2 = cell['bbox']
        return (x1 + x2) / 2, (y1 + y2) / 2

    def nearby(label, direction):
        lx, ly = center(label)
        lh = label['bbox'][3] - label['bbox'][1]
        found = []
        for cell in cells:
            match = NUMBER.fullmatch(cell['text'])
            if not match or cell is label:
                continue
            x, y = center(cell)
            if direction == 'below':
                fits = -.005*width <= cell['bbox'][0] - label['bbox'][0] <= width*.065 and lh*.35 < y-ly < lh*2.2
            else:
                fits = 0 < cell['bbox'][0] - label['bbox'][2] < width * .07 and abs(y - ly) < lh * .8
            if fits:
                found.append((cell, match))
        return found

    observations = []
    counts = {}
    for section, label_text in [('injection', '充填速度'), ('holding', '保压'), ('pressure', '限制压力')]:
        labels = [c for c in cells if c['text'].lstrip('◀◁< ') == label_text]
        matches = nearby(labels[0], 'below') if len(labels) == 1 else []
        matches = [(c, m) for c, m in matches if c['confidence'] >= .8 and float(m[1]).is_integer() and
                   1 <= float(m[1]) <= template['stage_limits'].get(section, 3)]
        if len(matches) == 1:
            counts[section] = (int(float(matches[0][1][1])), matches[0][0])
    vs1 = [c for c in cells if c['text'] == 'VS1']
    if len(vs1) == 1:
        x, y = center(vs1[0])
        options = [(c, NUMBER.fullmatch(c['text'])) for c in cells]
        options = [(c, m) for c, m in options if m and c['confidence'] >= .8 and
                   float(m[1]).is_integer() and 1 <= float(m[1]) <= 3 and
                   abs(center(c)[0] - x) < width * .08 and 0 < y-center(c)[1] < height * .12]
        if len(options) == 1:
            counts['plasticizing'] = (int(float(options[0][1][1])), options[0][0])

    proposals = []
    for label in cells:
        spec = next((spec for name, spec in template['field_labels'].items() if name.casefold() == label['text'].casefold()), None)
        if spec is not None:
            matches = nearby(label, spec['direction'])
            proposals.append((label, spec, matches[0] if len(matches) == 1 else None))
    for header_name in ('计量前', '计量后'):
        headers = [c for c in cells if c['text'] == header_name]
        if len(headers) != 1:
            continue
        header = headers[0]
        for row_name, unit in [('速度', 'mm/s'), ('距离', 'mm')]:
            rows = [c for c in cells if c['text'] == row_name and
                    0 < center(c)[1] - center(header)[1] < height*.12 and
                    0 < header['bbox'][0] - c['bbox'][2] < width*.12]
            if len(rows) != 1:
                continue
            row = rows[0]
            matches = [(c, NUMBER.fullmatch(c['text'])) for c in cells]
            matches = [(c, m) for c, m in matches if m and
                       abs(center(c)[0] - center(header)[0]) < width*.035 and
                       abs(center(c)[1] - center(row)[1]) < height*.018]
            spec = dict(section='scalar', unit=unit, role='setting', label=header_name + row_name,
                        row_index=row['index'])
            proposals.append((header, spec, matches[0] if len(matches) == 1 else None))
    uses = Counter(match[0]['index'] for _, _, match in proposals if match)
    for label, spec, match in proposals:
        chosen = match if match and uses[match[0]['index']] == 1 else None
        value = float(chosen[1][1]) if chosen else None
        unit = chosen[1][2] if chosen else None
        unit_cell = None
        if chosen and not unit:
            vx, vy = center(chosen[0])
            vh = chosen[0]['bbox'][3] - chosen[0]['bbox'][1]
            units = []
            for cell in cells:
                embedded = NUMBER.fullmatch(cell['text'])
                observed_unit = embedded[2] if embedded else cell['text']
                if (observed_unit == spec['unit'] and cell['confidence'] >= .8
                        and cell['bbox'][2] >= chosen[0]['bbox'][2]
                        and abs(center(cell)[1] - vy) < vh*.8):
                    units.append(cell)
            if units:
                unit_cell = min(units, key=lambda c: c['bbox'][0])
                unit = spec['unit']
        stage = spec.get('stage')
        section = spec['section']
        state = 'unknown'
        if stage and section in counts:
            count = counts[section][0]
            state = 'enabled' if stage <= count else 'disabled'
            if label['text'].lower().startswith(('tp', 'vsl', 'sv')) and stage >= count:
                state = 'disabled'
        reason = []
        if chosen and min(label['confidence'], chosen[0]['confidence']) < .8:
            reason.append('low_confidence')
        if not chosen:
            reason.append('value_missing_or_ambiguous')
        if not unit:
            reason.append('unit_unobserved')
        if stage and state == 'unknown':
            reason.append('stage_count_unobserved')
        observations.append(dict(label=spec.get('label', label['text']), value=value, unit=unit,
            role=spec.get('role', 'setting'), section=section, stage=stage, state=state,
            text=chosen[0]['text'] if chosen else None,
            confidence=min(label['confidence'], chosen[0]['confidence']) if chosen else 0,
            bbox=chosen[0]['bbox'] if chosen else None, original_bbox=None,
            line_indexes=[label['index']] + ([spec['row_index']] if 'row_index' in spec else []) + ([chosen[0]['index']] if chosen else []) +
                         ([unit_cell['index']] if unit_cell else []), reasons=reason))
    located = {o['label'] for o in observations if o['value'] is not None}
    observations = [o for o in observations if o['value'] is not None or o['label'] not in located]
    for anchor_text, spec in template.get('enum_labels', {}).items():
        anchors = [c for c in cells if c['text'] == anchor_text]
        if len(anchors) != 1:
            continue
        anchor = anchors[0]
        ax, ay = center(anchor)
        candidates = [c for c in cells if c['text'] in spec['values'] and c['confidence'] >= .8
                      and abs(center(c)[0] - ax) < width * .1
                      and 0 < center(c)[1] - ay < (anchor['bbox'][3] - anchor['bbox'][1]) * 3]
        if len(candidates) != 1:
            continue
        chosen = candidates[0]
        observations.append(dict(label=spec['label'], value=chosen['text'], unit=None,
            role='setting', section='scalar', stage=None, state='unknown', text=chosen['text'],
            confidence=min(anchor['confidence'], chosen['confidence']), bbox=chosen['bbox'],
            original_bbox=None, line_indexes=[anchor['index'], chosen['index']], reasons=[]))
    project_boxes(observations, meta)
    detail = dict(page_variant=template['layout_variant'], page_observations=dict(
        version='1.0', profile_id=template['profile_id'], coordinate_space='original_percent',
        fields=observations, stage_counts={k: dict(value=v, line_indexes=[c['index']])
                                         for k, (v, c) in counts.items()}))
    # Candidate observations require human confirmation; no legacy auto-import view is produced.
    return dict(fields={}, heater_columns=0, warnings=['TACT5_REVIEW_REQUIRED'], detail=detail)


def recover_stage_counts(ocr, image_path, lines, screen_size, missing):
    """Retry only a missing count whose printed 段 and section anchor are both located."""
    import cv2

    width, height = screen_size
    image = cv2.imread(str(image_path))
    if image is None:
        return []
    recovered = []
    for section, anchor_text in (('injection', '充填速度'), ('plasticizing', 'VS1')):
        if section not in missing:
            continue
        anchors = [line for line in lines if line['text'] == anchor_text]
        if len(anchors) != 1:
            continue
        anchor = anchors[0]['bbox']
        marks = []
        for line in lines:
            if line['text'] != '段' or line['conf'] < .7:
                continue
            box = line['bbox']
            if section == 'injection':
                near = (anchor['x_min'] <= box['x_min'] <= anchor['x_max'] + width*.06
                        and anchor['y_max'] < box['y_min'] < anchor['y_max'] + height*.08)
            else:
                near = (anchor['x_min'] < box['x_min'] < anchor['x_min'] + width*.15
                        and anchor['y_min'] - height*.09 < box['y_min'] < anchor['y_min'])
            if near:
                marks.append(line)
        if len(marks) != 1:
            continue
        mark = marks[0]['bbox']
        x1, y1 = max(0, int(mark['x_min'] - width*.065)), max(0, int(mark['y_min'] - height*.025))
        x2, y2 = min(width, int(mark['x_max'] + width*.02)), min(height, int(mark['y_max'] + height*.025))
        if x2 <= x1 or y2 <= y1:
            continue
        crop = cv2.resize(image[y1:y2, x1:x2], None, fx=3, fy=3,
                          interpolation=cv2.INTER_CUBIC)
        result = ocr.ocr(crop, cls=False)
        detected = result[0] if result and result[0] else []
        digits = [(box, text, conf) for box, (text, conf) in detected
                  if text in ('1', '2', '3', '4', '5', '6') and conf >= .8]
        suffixes = [(box, conf) for box, (text, conf) in detected
                    if text == '段' and conf >= .8]
        if len(digits) != 1 or len(suffixes) != 1:
            continue
        number_box, digit, number_conf = digits[0]
        suffix_box, suffix_conf = suffixes[0]
        if max(p[0] for p in number_box) >= min(p[0] for p in suffix_box):
            continue
        points = number_box + suffix_box
        xs = [x1 + p[0]/3 for p in points]
        ys = [y1 + p[1]/3 for p in points]
        recovered.append(dict(text=digit + '段', conf=min(number_conf, suffix_conf),
                              bbox=dict(x_min=min(xs), y_min=min(ys),
                                        x_max=max(xs), y_max=max(ys))))
    return recovered


def recover_time_units(ocr, image_path, observations, template, screen_size):
    """Retry a missing scalar time unit only when the printed suffix glyph is itself located.

    Full-screen OCR drops the small 's' next to 射出/中间 values (Z078). The crop overlaps
    the value's right edge by a few pixels and is padded with a white border—without both,
    detection returns nothing for the thin strip—and is accepted only when the sole confident
    detection is the expected unit glyph. Case is normalized to the template unit, matching
    NUMBER's case-insensitive embedded units.
    """
    import cv2

    specs = {spec.get('label', name): spec for name, spec in template.get('field_labels', {}).items()
             if spec.get('section') == 'scalar' and spec.get('direction') == 'right'
             and spec.get('unit') == 's'}
    if not specs:
        return []
    image = cv2.imread(str(image_path))
    if image is None:
        return []
    width, height = screen_size
    scale, pad = 3, 30
    recovered = []
    for observation in observations:
        if (observation.get('label') not in specs or observation.get('value') is None
                or observation.get('unit') is not None or not observation.get('bbox')):
            continue
        vx1, vy1, vx2, vy2 = observation['bbox']
        x1, y1 = max(0, int(vx2 - 4)), max(0, int(vy1 - height * .01))
        x2, y2 = min(width, int(vx2 + width * .05)), min(height, int(vy2 + height * .01))
        if x2 <= x1 or y2 <= y1:
            continue
        crop = cv2.resize(image[y1:y2, x1:x2], None, fx=scale, fy=scale,
                          interpolation=cv2.INTER_CUBIC)
        crop = cv2.copyMakeBorder(crop, pad, pad, pad, pad, cv2.BORDER_CONSTANT,
                                  value=(255, 255, 255))
        result = ocr.ocr(crop, cls=False)
        detected = [(box, text, conf) for box, (text, conf) in
                    (result[0] if result and result[0] else []) if conf >= .8]
        glyphs = [(box, conf) for box, text, conf in detected
                  if text.strip().casefold() == 's']
        if len(detected) != 1 or len(glyphs) != 1:
            continue
        (glyph_box, glyph_conf), = glyphs
        xs = [x1 + (p[0] - pad) / scale for p in glyph_box]
        ys = [y1 + (p[1] - pad) / scale for p in glyph_box]
        if max(xs) < vx2:  # glyph must sit at the value's right edge, not inside it
            continue
        recovered.append(dict(text='s', conf=glyph_conf, _src='tact5_unit_rescue',
                              bbox=dict(x_min=min(xs), y_min=min(ys),
                                        x_max=max(xs), y_max=max(ys))))
    return recovered


def project_boxes(observations, meta):
    """Invert the same ordered screen quad used by rectify; absent metadata stays unlocated."""
    if not meta.get('original_size') or not meta.get('screen_quad'):
        return
    import cv2
    import numpy as np
    from quality import order_points
    w, h = meta['screen_size']
    ow, oh = meta['original_size']
    src = np.array([[0, 0], [w-1, 0], [w-1, h-1], [0, h-1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(src, order_points(np.array(meta['screen_quad'], dtype=np.float32)))
    for observation in observations:
        if observation['bbox'] is None:
            continue
        x1, y1, x2, y2 = observation['bbox']
        corners = np.array([[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]], dtype=np.float32)
        points = cv2.perspectiveTransform(corners, matrix)[0]
        box = [float(points[:, 0].min()/ow*100), float(points[:, 1].min()/oh*100),
               float(points[:, 0].max()/ow*100), float(points[:, 1].max()/oh*100)]
        if all(0 <= value <= 100 for value in box) and box[0] < box[2] and box[1] < box[3]:
            observation['original_bbox'] = box
