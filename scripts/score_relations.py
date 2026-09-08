"""Score reviewed, normalized relations; never infer truth from model output.

Input JSON: {"truth": [...], "predictions": [...]}. Each row has category,
parameter (reviewed meaning), value, unit, role, label (screen segment/zone).
Truth also requires status=verified|unresolved. Freeze semantic normalization
before evaluation; do not equate similar labels or infer array positions here.
Use an empty predictions list for a failed request, never remove its truth.
"""
import argparse
from collections import Counter
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path


def score_relations(truth, predictions):
    counters = [{}, {}]
    unresolved = Counter()
    for side, rows in enumerate((truth, predictions)):
        if not isinstance(rows, list):
            raise ValueError('Relations must be lists')
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError('Relation must be an object')
            category = row.get('category')
            if not isinstance(category, str) or not category.strip():
                raise ValueError('Category is required')
            if side == 0:
                if row.get('status') not in ('verified', 'unresolved'):
                    raise ValueError('Truth requires an explicit verification status')
                if row['status'] == 'unresolved':
                    unresolved[category] += 1
                    continue
            for key in ('parameter', 'unit', 'role', 'label'):
                if key not in row or not (isinstance(row[key], str) or row[key] is None):
                    raise ValueError(f'Invalid or missing {key}')
            if not row['parameter'] or not row['role'] or 'value' not in row:
                raise ValueError('Parameter, role and value are required')
            value = row['value']
            if value is None and side == 1:
                number = None  # A missing model value is an unmatched candidate.
            else:
                try:
                    if isinstance(value, bool):
                        raise ValueError('Boolean is not a number')
                    number = Decimal(str(value))
                    if not number.is_finite():
                        raise ValueError('Non-finite value')
                except InvalidOperation as exc:
                    raise ValueError('Invalid numeric value') from exc
            key = (row['parameter'], number, row['unit'], row['role'], row['label'])
            counters[side].setdefault(category, Counter())[key] += 1
    report = {}
    for category in sorted(set(counters[0]) | set(counters[1]) | set(unresolved)):
        expected = counters[0].get(category, Counter())
        actual = counters[1].get(category, Counter())
        tp = sum((expected & actual).values())
        fp, fn = sum(actual.values()) - tp, sum(expected.values()) - tp
        report[category] = {
            'tp': tp, 'fp': fp, 'fn': fn, 'unresolved_truth': unresolved[category],
            'precision': tp / (tp + fp) if tp + fp else None,
            'recall': tp / (tp + fn) if tp + fn else None,
            'missing': [list(key) for key in (expected - actual).elements()],
            'unexpected': [list(key) for key in (actual - expected).elements()],
        }
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    data = json.loads(args.input.read_text())
    print(json.dumps(score_relations(data['truth'], data['predictions']),
                     ensure_ascii=False, indent=2, default=str, allow_nan=False))
