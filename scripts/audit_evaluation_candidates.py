"""CPU-only evidence audit. Run: python3 scripts/audit_evaluation_candidates.py.

Does not change training data, draft annotations, or services. A shortlist is
not acceptance; perceptual hashes are triage, not proof of independence.
"""
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/reviews/eval-audit-20260927'
OUT.mkdir(parents=True, exist_ok=True)
CAT = ROOT / 'datasets/hmi/catalog'
raw = json.loads((ROOT / 'datasets/hmi/raw/feishu/20260927/manifest.json').read_text())
train = json.loads((CAT / 'training-manifest-20260927-tact5.json').read_text())
reserved = json.loads((CAT / 'reserved-manifest.json').read_text())
train_shas = {e['image_sha256'] for e in train}
reserved_shas = {e['image_sha256'] for e in reserved}
by_sha = defaultdict(list)
for e in raw:
    by_sha[e['sha256']].append(e)
candidates = set(by_sha) - train_shas - reserved_shas
assert len(candidates) == 208
paths = defaultdict(set)
for line in (CAT / 'images.jsonl').read_text().splitlines():
    e = json.loads(line)
    paths[e['sha256']].update(e['paths'])
for sha, entries in by_sha.items():
    paths[sha].update(e['path'] for e in entries)
train_machines = set()
train_recipes = set()
train_records = set()
train_identity = []
for e in train:
    p = ROOT / 'output/training-prep' / e['dir'] / e['id'] / 'annotation.json'
    a = json.loads(p.read_text())
    paths[e['image_sha256']].add(str(p.parent / a['image']))
    # Historical inj_zNNN identifiers and provenance paths are not null machines.
    identity_text = json.dumps([a.get('machine_id'), a.get('group_id'), a.get('sources'), a.get('images')])
    machines = sorted(set(re.findall(r'(?i)(?<![A-Z0-9])Z\d{3}(?!\d)', identity_text.upper())))
    records = re.findall(r'rec[A-Za-z0-9]+', identity_text)
    train_machines.update(machines)
    train_records.update(records)
    recipes = set(re.findall(r'(?:TXE?|GMT|TWT)\d{3,}', str(a.get('group_id') or '')))
    for source in by_sha.get(e['image_sha256'], []):
        machines.append(source['machine'])
        train_machines.add(source['machine'])
        recipes.add((source.get('mold') or 'unknown').split('/')[0])
        train_records.add(source['record_id'])
    train_recipes.update(recipes - {'unknown'})
    train_identity.append({'id':e['id'], 'sha256':e['image_sha256'], 'machines':sorted(set(machines)), 'recipe_families':sorted(recipes), 'sources':a.get('sources'), 'unresolved':not machines})

historical = json.loads((ROOT / 'output/s070_corpus_inventory/corpus_inventory.json').read_text())
exposure = defaultdict(list)
historical_machines = defaultdict(list)
for e in historical:
    paths[e['sha256']].update(e.get('paths', []))
    if e.get('tuning_involved') or e.get('has_truth') or e.get('partition'):
        evidence = {'source':'output/s070_corpus_inventory/corpus_inventory.json', 'sha256':e['sha256'], 'paths':e.get('paths', []), 'tuning_involved':e.get('tuning_involved'), 'partition':e.get('partition')}
        exposure[e['sha256']].append(evidence)
        for machine in set(re.findall(r'(?i)(?<![A-Z0-9])Z\d{3}(?!\d)', json.dumps(e.get('paths', [])).upper())):
            historical_machines[machine].append(evidence)
for e in reserved:
    exposure[e['image_sha256']].append({'source':'datasets/hmi/catalog/reserved-manifest.json','group':e.get('group')})
    for machine in re.findall(r'Z\d{3}', str(e.get('group')).upper()):
        historical_machines[machine].append({'source':'datasets/hmi/catalog/reserved-manifest.json','sha256':e['image_sha256']})
inference = json.loads((ROOT / 'output/inference-tests/batch-20260926-feishu/manifest.json').read_text())
exposed_records = set()
exposed_recipes = set()
for e in inference:
    evidence = {'source':'output/inference-tests/batch-20260926-feishu/results-summary.json','number':e['number'],'sha256':e['sha256'],'record_id':e['record_id'],'machine':e['machine'],'mold':e['mold']}
    exposure[e['sha256']].append(evidence)
    historical_machines[e['machine']].append(evidence)
    exposed_records.add(e['record_id'])
    exposed_recipes.add(e['mold'].split('/')[0])

screening = defaultdict(list)
near_edges = []
all_shas = set(paths) | candidates
for p in sorted((ROOT / 'output/reviews/screening-20260927').glob('screening-*.json')):
    d = json.loads(p.read_text())
    items = d if isinstance(d,list) else d.get('images',d.get('items',d.get('samples',[])))
    for e in items:
        if not isinstance(e,dict) or 'sha256' not in e:
            continue
        screening[e['sha256']].append({'source':str(p.relative_to(ROOT)), **e})
        target = e.get('near_dup_of')
        if target:
            hits = [s for s in all_shas if s.startswith(target)]
            for hit in hits:
                near_edges.append((e['sha256'], hit))

# Group graph includes explicit historical visual findings, across dates/mold labels.
adjacency = defaultdict(set)
for a,b in near_edges:
    adjacency[a].add(b)
    adjacency[b].add(a)
components = {}
for sha in sorted(all_shas):
    if sha in components:
        continue
    pending = [sha]
    members = set()
    while pending:
        item = pending.pop()
        if item in members:
            continue
        members.add(item)
        pending.extend(adjacency[item] - members)
    for item in members:
        components[item] = sorted(members)

# Whole-image similarity shortlist: correct DCT-II, EXIF-normalized views.
# ponytail: hashes miss perspective/crop changes; retain visual/source group blocks.
fingerprints = {}
missing = []
mismatch = []
grid = np.cos(np.pi / 32 * np.arange(32)[:,None] * (np.arange(32)+0.5))
for sha in sorted(all_shas):
    available = [ROOT / p for p in sorted(paths[sha]) if (ROOT / p).is_file()]
    if not available:
        missing.append(sha)
        continue
    p = available[0]
    if hashlib.sha256(p.read_bytes()).hexdigest() != sha:
        mismatch.append({'sha256':sha,'path':str(p)})
        continue
    with Image.open(p) as im:
        im = ImageOps.exif_transpose(im).convert('L')
        arr = np.asarray(im.resize((32,32),Image.Resampling.LANCZOS),dtype=float)
        low = (grid @ arr @ grid.T)[:8,:8].reshape(-1)[1:]
        dh = np.asarray(im.resize((9,8),Image.Resampling.LANCZOS))
        fingerprints[sha] = (low > np.median(low), (dh[:,1:] > dh[:,:-1]).reshape(-1))
assert not mismatch, mismatch
keys = sorted(fingerprints)
ph = np.stack([fingerprints[s][0] for s in keys])
dh = np.stack([fingerprints[s][1] for s in keys])
rows = []
for sha in sorted(candidates):
    entries = by_sha[sha]
    e = entries[0]
    machine = e['machine']
    recipe = (e.get('mold') or 'unknown').split('/')[0]
    members = components[sha]
    reasons = []
    if set(members) & train_shas:
        reasons.append('visual_near_duplicate_of_training')
    if recipe in train_recipes:
        reasons.append('recipe_family_in_training')
    if e['record_id'] in train_records:
        reasons.append('capture_record_in_training')
    if any(exposure.get(s) for s in members):
        reasons.append('image_or_visual_group_historical_exposure')
    if e['record_id'] in exposed_records or recipe in exposed_recipes:
        reasons.append('capture_or_recipe_historical_inference')
    fp = fingerprints[sha]
    pd = np.count_nonzero(ph != fp[0],axis=1)
    dd = np.count_nonzero(dh != fp[1],axis=1)
    nearest = np.argsort(pd+dd)
    close = [{'sha256':keys[i],'phash_distance':int(pd[i]),'dhash_distance':int(dd[i]),'train':keys[i] in train_shas,'historical':bool(exposure.get(keys[i]))} for i in nearest if keys[i] != sha][:5]
    boundary = [r for r in close if r['phash_distance'] <= 10 and r['dhash_distance'] <= 12 and (r['train'] or r['historical'])]
    if boundary:
        reasons.append('perceptual_boundary_review_required')
    source_keys = ('brand','machine','mold','date','record_id','base_token','table_id','field','slot','path')
    rows.append({'sha256':sha,'id':sha[:16], 'sources':[{k:r.get(k) for k in source_keys} for r in entries], 'machine':machine,'recipe_family':recipe,'capture_group':e['base_token']+'/'+e['table_id']+'/'+e['record_id'], 'visual_group':members[0], 'visual_group_members':members,'prior_screening':screening[sha], 'train_machine':machine in train_machines,'historical_machine_evidence':historical_machines[machine],'direct_exposure':exposure.get(sha, []), 'nearest_images':close,'blocked_reasons':reasons,'shortlist_status':'excluded' if reasons else ('validation_candidate' if machine in train_machines or historical_machines[machine] else 'test_candidate_pending_source_alias_and_visual_review')})
assert len(rows) == len({r['sha256'] for r in rows}) == 208
summary = {'candidate_count':len(rows),'status_counts':dict(Counter(r['shortlist_status'] for r in rows)), 'train_machines':sorted(train_machines),'unresolved_training_identity':[r['id'] for r in train_identity if r['unresolved']], 'reserved_missing_images':sorted(reserved_shas & set(missing)), 'fingerprinted_images':len(fingerprints), 'historical_missing_images':len(missing),'limitations':['No full factory inventory claim; current local acquisition only.','Location aliases A/B codes are not globally unique machine IDs.','All indexed historical images resolved; unknown aliases and unindexed history remain outside automatic clearance.','Candidate status is not accepted annotation or blind-test certification.']}
(OUT/'candidates.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
(OUT/'training-identity.json').write_text(json.dumps(train_identity,ensure_ascii=False,indent=2))
(OUT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
(OUT/'historical-machine-exposure.json').write_text(json.dumps(historical_machines,ensure_ascii=False,indent=2))
print(json.dumps(summary,ensure_ascii=False,indent=2))
