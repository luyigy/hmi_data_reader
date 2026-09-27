"""Offline check: cleaned targets retain values, boxes and genuine unknowns."""
import copy
import json
import re
from scripts.train_small_sample import ROOT, PROMPT, read_samples

snapshot = ROOT / 'output/training-prep/cleanup-20260926/before.json'
before = json.loads(snapshot.read_text())
rows = read_samples()
# Explicit Q6 arrow/checkbox edits supersede the historical field-freeze check.
deltas = json.loads((ROOT / 'output/reviews/codex-final-20260927/authorized-field-deltas.json').read_text())
assert {r['id'] for r in rows} == {r['id'] for r in before.values()}
assert '日精' not in PROMPT and '射出时间减' not in PROMPT
for name, old in before.items():
    current = json.loads((ROOT / name).read_text())
    original_fields = copy.deepcopy(old['answer']['fields'])
    for field in original_fields.values():
        field.pop('correction', None)
    for key, change in deltas.get(current['id'], {}).items():
        assert original_fields.get(key) == change['before'], (name, key)
        if change['after'] is None:
            original_fields.pop(key)
        else:
            original_fields[key] = change['after']
    assert current['answer']['fields'] == original_fields, name
    for key in old.keys() - {'answer'}:
        assert current[key] == old[key], (name, key)
    for key in ('schema_version', 'machine_type', 'page'):
        assert current['answer'].get(key) == old['answer'].get(key), (name, key)
    if current['answer'] != old['answer']:
        assert current['training_answer_cleanup']['original_answer'] == old['answer']
    target = json.dumps(current['answer'], ensure_ascii=False)
    assert not re.search(r'2026-|裁定|legacy|金标|草稿|修订|Kimi|case-\d', target), name
by_id = {r['id']: r['answer'] for r in rows}
assert '实际充填时间未显示' in by_id['099e72f915e66c96']['uncertainties'][0]
assert '歧义' in by_id['84b265841db4b9b1']['uncertainties'][0]
assert '设定/实际语义待确认' in by_id['f627d3c02ac89703']['uncertainties'][1]
print(f'PASS: {len(rows)} samples; authorized Q6 field deltas checked, other fields/status unchanged, unknowns retained')
