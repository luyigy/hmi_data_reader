import json, pathlib

root = pathlib.Path(__file__).resolve().parent
def read(mode):
    return [json.loads(line) for line in (root / (mode+'.timeline.jsonl')).read_text().splitlines()]

c, h, i = (read(mode) for mode in ('control', 'headless', 'interactive'))
assert any(e.get('name') == 'obsolete' for e in c), 'Invalid control'
sent = next(e['t'] for e in h if e['kind']=='send' and e['t']>1)
finished = next(e['t'] for e in h if e.get('name')=='finished')
assert sent < finished, 'Correction arrived too late'
results = [e for e in h if e.get('data',{}).get('event')=='result']
assert len(results)==2 and results[0]['t']>sent
assert 'OLD_DONE' in results[0]['data']['result']['response']
assert 'NEW_DONE BLUE731' in results[1]['data']['result']['response']
assert results[0]['data']['result']['conversation_id']==results[1]['data']['result']['conversation_id']
assert any(e.get('name')=='obsolete' for e in h)
assert i[-1]['kind']=='summary', 'Interactive observation not finished'
assert 'started' in i[-1]['files'] and 'finished' in i[-1]['files']
assert 'obsolete' not in i[-1]['files']
assert any('queued messages' in e.get('text','') for e in i)
assert any('NEW_DONE BLUE731' in e.get('text','') for e in i if e['kind']=='terminal')
assert next(e['t'] for e in i if e['kind']=='send') < next(e['t'] for e in i if e.get('name')=='finished')
print('PASS: control executed old action; headless queued next turn; interactive redirected before old action.')
