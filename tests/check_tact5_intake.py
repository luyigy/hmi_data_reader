"""Offline intake check: python3 -m tests.check_tact5_intake (no GPU)."""
import hashlib
import json
import re
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image
from scripts import train_small_sample as training

root = training.ROOT
catalog = root / 'datasets/hmi/catalog'
source = root / 'datasets/hmi/annotations/nissei-tact5-20260926'
manifest = catalog / 'training-manifest-20260927-tact5.json'
entries = json.loads(manifest.read_text())
previous = json.loads((catalog / 'training-manifest-20260927-reviewed.json').read_text())
assert len(previous) == 60 and entries[:60] == previous and len(entries) == 65
requirements = json.loads((catalog / 'next-training-requirements.json').read_text())
assert requirements['training_manifest_sha256'] == hashlib.sha256(manifest.read_bytes()).hexdigest()
assert requirements['vision'] == requirements['language'] == 'LoRA'
assert requirements['base_weights'] == 'frozen' and requirements['full_finetuning'] is False
rulings = json.loads((source / 'user-rulings-20260927.json').read_text())
groups = {}
fields = boxes = 0
for entry in entries[60:]:
    folder = root / 'output/training-prep' / entry['dir'] / entry['id']
    row = json.loads((folder / 'annotation.json').read_text())
    original_path = root / row['provenance']['source_answer']
    original = json.loads(original_path.read_text())
    assert hashlib.sha256(original_path.read_bytes()).hexdigest() == row['provenance']['source_answer_sha256']
    assert row['answer']['fields'] == original['fields']
    assert row['evaluation_status'] == 'development_exposed_not_independent_test'
    assert row['status'] == 'human_confirmed' and row['split'] == 'train'
    assert not row['reserved_evaluation']
    groups.setdefault(row['group_id'], []).append(row['id'])
    with Image.open(folder / row['image']) as image:
        image.load()
        assert image.getexif().get(274, 1) == 1
        for field in row['answer']['fields'].values():
            if field.get('bbox') is None:
                continue
            x1, y1, x2, y2 = field['bbox']
            assert 0 <= x1 < x2 <= 100 and 0 <= y1 < y2 <= 100
            boxes += 1
    for key, change in rulings['applied_changes'][original_path.name].items():
        assert row['answer']['fields'][key]['value'] is None
        assert any(key + '=' + str(change['was']) in s for s in row['answer']['uncertainties'])
    text = json.dumps(row['answer'], ensure_ascii=False)
    assert not re.search(r'2026-|裁定|待确认|暂保留显示值|共用限制压力口径', text)
    fields += len(row['answer']['fields'])
assert fields == 244 and boxes == 238 and len(groups) == 4
assert set(groups['日精/Z078/TX22064/100-17018']) == {'Z078_20260910_shebao', 'Z078_20260912_shebao'}
deferred = {r['image_sha256'] for r in json.loads((source / 'manifest.json').read_text())['entries'] if not r['answer']}
assert not deferred & {r['image_sha256'] for r in entries}
original_manifest, original_reserved = training.MANIFEST, training.RESERVED
try:
    assert len(training.read_samples()) == 28
    training.MANIFEST = manifest
    rows = training.read_samples()
    assert len(rows) == 65 and sum(len(r['answer']['fields']) for r in rows) == 2116
    with TemporaryDirectory() as directory:
        training.RESERVED = Path(directory) / 'reserved.json'
        reserved = json.loads(original_reserved.read_text())
        reserved.append({'image_sha256': rows[-1]['image_sha256']})
        training.RESERVED.write_text(json.dumps(reserved))
        assert [r['id'] for r in training.read_samples()] == [r['id'] for r in rows[:-1]]
finally:
    training.MANIFEST, training.RESERVED = original_manifest, original_reserved
print('PASS: 65 samples / 2116 fields; TACT5 244 fields / 238 boxes unchanged; 4 training-side groups; reserved exclusion; LoRA-only requirements')
