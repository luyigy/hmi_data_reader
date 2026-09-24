"""Run with python3 tests/check_training_packet.py; uses the real review inventory."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    out = Path(directory)
    command = [sys.executable, str(root / 'scripts/prepare_training_packet.py'), '--output', directory]
    subprocess.run(command, check=True, capture_output=True)
    manifest = [json.loads(line) for line in (out / 'manifest.jsonl').read_text().splitlines()]
    inventory = [json.loads(line) for line in (root / 'output/training-prep/review.jsonl').read_text().splitlines()]
    assert len(manifest) == len(inventory)
    for row in manifest:
        data = json.loads((out / row['annotation']).read_text())
        assert data['answer'] is None and data['split'] is None
        assert data['status'] == 'needs_human_review'
        assert (out / row['image']).is_file()
    sample = out / manifest[0]['annotation']
    data = json.loads(sample.read_text())
    data['review_notes'] = ['preserve my edits']
    sample.write_text(json.dumps(data))
    before = sample.read_bytes()
    subprocess.run(command, check=True, capture_output=True)
    assert sample.read_bytes() == before, 'rerun overwrote human edits'
    reserved = next(row for row in manifest if row['reserved_evaluation'])
    sample = out / reserved['annotation']
    data = json.loads(sample.read_text())
    data['split'] = 'train'
    sample.write_text(json.dumps(data))
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode != 0 and 'reserved image leaked' in result.stderr
print('training packet checks OK: inventory, empty gold, preserved edits, evaluation guard')
