"""Offline intake: python3 -m tests.check_evaluation_sets."""
import hashlib
import json
from pathlib import Path
from PIL import Image
from scripts.train_small_sample import read_samples

ROOT = Path(__file__).resolve().parents[1]
CAT = ROOT / 'datasets/hmi/catalog'
train = json.loads((CAT / 'training-manifest-20260927-tact5.json').read_text())
assert len(read_samples(CAT / 'training-manifest-20260927-tact5.json')) == 65
seen = {e['image_sha256'] for e in train}
train_machines = set()
for e in train:
    a = json.loads((ROOT / 'output/training-prep' / e['dir'] / e['id'] / 'annotation.json').read_text())
    train_machines.add(a.get('machine_id'))
    gid = a.get('group_id') or e.get('group_id') or ''
    if '/' in gid:
        train_machines.add(gid.split('/')[1])
for name, split, count in [('validation', 'val', 6), ('test', 'test', 9)]:
    entries = json.loads((CAT / f'{name}-manifest-20260927.json').read_text())
    assert len(entries) == count
    fields = 0
    for e in entries:
        folder = ROOT / 'output/training-prep' / e['dir'] / e['id']
        path = folder / 'annotation.json'
        a = json.loads(path.read_text())
        assert hashlib.sha256(path.read_bytes()).hexdigest() == e['annotation_sha256']
        assert hashlib.sha256((folder / 'answer.json').read_bytes()).hexdigest() == e['answer_sha256']
        assert json.loads((folder / 'answer.json').read_text()) == a['answer']
        digest = hashlib.sha256((folder / a['image']).read_bytes()).hexdigest()
        assert digest == e['image_sha256'] == a['image_sha256'] and digest not in seen
        seen.add(digest)
        assert a['split'] == split and a['reserved_evaluation'] is True
        assert a['status'] == 'agent_visual_verified'
        if split == 'test':
            assert a['machine_id'] not in train_machines
        with Image.open(folder / a['image']) as im:
            im.load()
            assert list(im.size) == a['image_size']
            assert im.getexif().get(274, 1) == a['exif_orientation']
        assert a['answer']['fields']
        for f in a['answer']['fields'].values():
            x1, y1, x2, y2 = f['bbox']
            assert 0 <= x1 < x2 <= 100 and 0 <= y1 < y2 <= 100
            fields += 1
    print(f'PASS: {name}: {count} images / {fields} fields; hashes, decoding, labels and isolation')
lock = json.loads((CAT / 'test-lock-20260927.json').read_text())
assert lock['manifest_sha256'] == hashlib.sha256((CAT / 'test-manifest-20260927.json').read_bytes()).hexdigest()
assert lock['entries'] == json.loads((CAT / 'test-manifest-20260927.json').read_text())
print('PASS: test lock matches; historical exposure remains disclosed')
