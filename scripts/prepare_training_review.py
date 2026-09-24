"""Inventory existing injection labels; never promote old model output to gold.

Run with .venv/bin/python scripts/prepare_training_review.py.
Outputs a deduplicated review queue, not a training dataset.
"""
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

import yaml

root = Path(__file__).resolve().parents[1]
out = root / 'output/training-prep'
out.mkdir(parents=True, exist_ok=True)
images = defaultdict(list)
for folder in ('datasets', 'ground_truth', 'output', 'docs'):
    for path in sorted((root / folder).rglob('*')):
        if path.is_file() and path.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp'}:
            images[path.name].append(path)

reserved = set()
for partition in ('holdout', 'regression'):
    for path in (root / 'datasets' / partition).rglob('*'):
        if path.is_file() and path.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp'}:
            reserved.add(hashlib.sha256(path.read_bytes()).hexdigest())

queue = {}
missing = []
label_count = 0
sources = sorted((root / 'ground_truth').rglob('*.truth.json'))
sources += sorted((root / 'datasets').glob('*/*/*.truth.yml'))
for source in sources:
    data = yaml.safe_load(source.read_text())
    if data.get('page_type') != 'injection_metering':
        continue
    label_count += 1
    name = data.get('image')
    if isinstance(name, dict):
        name = name.get('file')
    matches = images.get(name, [])
    if not matches:
        missing.append({'source': str(source), 'image': name})
        continue
    # Same basename can refer to different images; keep all for human resolution.
    for path in matches:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        item = queue.setdefault(digest, {
            'id': digest[:16], 'image_sha256': digest, 'images': [], 'sources': [],
            'controller_family': data.get('controller_family'),
            'status': 'needs_human_review',
            'reserved_evaluation': digest in reserved,
            'group_id': None, 'split': None, 'answer': None,
        })
        if str(path) not in item['images']:
            item['images'].append(str(path))
        if str(source) not in item['sources']:
            item['sources'].append(str(source))

rows = sorted(queue.values(), key=lambda row: (row['controller_family'] or '', row['id']))
# These checks deliberately forbid generating training-ready answers or splits.
assert len(rows) == len({row['image_sha256'] for row in rows})
assert all(row['answer'] is None and row['split'] is None for row in rows)
assert all(row['reserved_evaluation'] == (row['image_sha256'] in reserved) for row in rows)
(out / 'review.jsonl').write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n'
                                       for row in rows))
summary = {'source_labels': label_count, 'unique_images': len(rows),
           'reserved_evaluation': sum(row['reserved_evaluation'] for row in rows),
           'families': dict(Counter(row['controller_family'] for row in rows)),
           'missing_images': missing, 'training_ready': 0}
(out / 'inventory.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(summary, ensure_ascii=False, indent=2))
