"""Reproducible S01 crop evidence from real images and frozen real OCR.

Crops are derived perturbations, not independent holdouts. OCR is restricted to
the crop and translated; it is not rerun on crop pixels. Live OCR is checked
separately, so this matrix measures routing rather than the OCR/quality gate.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path

import cv2

from page_identity import line_box, route_identities
from rectify import rectify

ROOT = Path(__file__).resolve().parents[1]


def verify(output):
    output.mkdir(parents=True, exist_ok=True)
    sources = [
        ('br', 'tests/fixtures/b_and_r_stability/live_20261029_curve_context.jpg',
         'tests/fixtures/b_and_r_stability/live_20261029_curve_context.json', [
             ('full', None, 'matched'), ('injection_local', [100, 440, 1130, 750], 'matched'),
             ('numeric_only', [300, 530, 1050, 700], 'unknown')]),
        ('nissei', 'datasets/r6_nissei/tact5.process_settings.injection_holding_metering/development/Z078_20260910_shebao.jpg',
         'tests/fixtures/tact5_process_ocr.json', [
             ('full', None, 'matched'), ('fill_local', [185, 440, 980, 600], 'unknown'),
             ('metering_local', [990, 520, 1380, 740], 'matched')]),
    ]
    matrix, results = [], []
    for name, original, frozen, cases in sources:
        image = output / (name + '_rectified.png')
        meta = rectify(ROOT / original, image)
        if not meta['ok']:
            raise ValueError('Rectification failed: ' + original)
        pixels = cv2.imread(str(image))
        raw = json.loads((ROOT / frozen).read_text())
        evidence = raw.get('ocr_evidence', raw)
        source_hash = hashlib.sha256((ROOT / original).read_bytes()).hexdigest()
        for case, crop, expected in cases:
            height, width = pixels.shape[:2]
            x0, y0, x1, y1 = crop or [0, 0, width, height]
            lines = []
            for line in evidence['lines']:
                box = line_box(line)
                if box and x0 <= box[0] < box[2] <= x1 and y0 <= box[1] < box[3] <= y1:
                    lines.append({**line, 'bbox': [box[0]-x0, box[1]-y0, box[2]-x0, box[3]-y0]})
            cv2.imwrite(str(output / f'{name}_{case}.jpg'), pixels[y0:y1, x0:x1])
            decision = route_identities(lines)
            matrix.append(dict(sample=name, case=case, expected=expected, actual=decision['status'],
                               profile_id=decision['profile_id'], passed=decision['status'] == expected,
                               original_sha256=source_hash))
            results.append(dict(sample=name, case=case, source_image=original, source_ocr=frozen,
                                crop=crop, decision=decision))
    with (output / 'matrix.csv').open('w') as stream:
        writer = csv.DictWriter(stream, matrix[0].keys())
        writer.writeheader()
        writer.writerows(matrix)
    (output / 'decisions.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    summary = dict(cases=len(matrix), passed=sum(row['passed'] for row in matrix),
                   scope='Known development images; derived crops replay frozen OCR, not independent holdouts or fresh crop OCR.')
    (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False))
    if summary['passed'] != summary['cases']:
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    verify(parser.parse_args().output)
