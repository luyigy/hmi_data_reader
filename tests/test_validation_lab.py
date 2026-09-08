"""Offline lab checks: synthetic OCR, isolated files, never imports GPU or Web DB."""
from copy import deepcopy
import io
import json
import zipfile

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from validation_lab.app import create_app
from validation_lab.mapping import CATALOG, FIXTURE, preview


def result(fields=None):
    return {'success': True, 'status': 'ok', 'quality': {'triage': 'green'},
            'profile_id': 'demag.temperature.screen_order_5', 'profile_status': 'verified',
            'profile_confidence': .99, 'contract_version': CATALOG['contract_version'],
            'controller_family': 'DEMAG', 'page_type': 'temperature', 'warnings': [],
            'fields': fields or {'barrel_temperature_set_c': [350, 295, 290, 285]}}


def session(*results):
    return {'target': deepcopy(FIXTURE['parameter_data']), 'edits': {},
            'images': [{'id': str(i), 'mold_target': '', 'attempts': [{'result': r}]} for i, r in enumerate(results)]}


def png(color='white'):
    out = io.BytesIO()
    Image.new('RGB', (20, 20), color).save(out, 'PNG')
    return out.getvalue()


def test_temperature_uses_identity_not_screen_index():
    s = session(result())
    original = deepcopy(s)
    p = preview(s)
    assert p['counts']['ready'] == 4
    assert [r['target'] for r in p['rows']] == [
        f'/temperature/zones/{i}/set_temperature/raw_value' for i in (0, 3, 2, 1)]
    assert [z['set_temperature']['raw_value'] for z in p['automatic_parameter_data']['temperature']['zones'][:4]] == [350, 285, 290, 295]
    assert s == original


@pytest.mark.parametrize('change', ['version', 'profile', 'quality', 'count', 'unit', 'disabled', 'range'])
def test_unsafe_inputs_never_pass(change):
    r = result()
    s = session(r)
    r = s['images'][0]['attempts'][0]['result']
    if change == 'version': r['contract_version'] = '999.0.0'
    if change == 'profile': r['profile_status'] = 'candidate'
    if change == 'quality': r['quality']['triage'] = 'red'
    if change == 'count': s['target']['temperature']['zones'].pop(0)
    if change == 'unit':
        for z in s['target']['temperature']['zones']: z['set_temperature']['raw_unit'] = '°F'
    if change == 'disabled': r['stage_enabled'] = {'barrel_temperature_set_c': [False] * 4}
    if change == 'range': r['fields']['barrel_temperature_set_c'] = [2900] * 4
    p = preview(s)
    assert p['counts']['ready'] == 0
    assert p['automatic_parameter_data'] == s['target']


def test_conflict_requires_explicit_resolution_and_null_does_not_erase():
    s = session(result(), result({'barrel_temperature_set_c': [None, 296, 290, 285]}))
    p = preview(s)
    conflict = [r for r in p['rows'] if r['target'] == '/temperature/zones/3/set_temperature/raw_value']
    assert len(conflict) == 2 and all(r['status'] == 'blocked' for r in conflict)
    assert p['automatic_parameter_data']['temperature']['zones'][3]['set_temperature']['raw_value'] is None
    s['images'][1]['excluded'] = True
    assert preview(s)['counts']['ready'] == 4


def test_correction_never_rewrites_raw_or_automatic_preview():
    s = session(result({'barrel_temperature_set_c': [None, 295, 290, 285]}))
    row = preview(s)['rows'][0]
    s['edits'][row['id']] = {'value': 350, 'target': '/temperature/zones/0/set_temperature/raw_value', 'confirmed': True}
    p = preview(s)
    assert p['rows'][0]['status'] == 'manual'
    assert p['rows'][0]['raw_status'] != 'ready'
    assert p['automatic_parameter_data']['temperature']['zones'][0]['set_temperature']['raw_value'] is None
    assert p['corrected_parameter_data']['temperature']['zones'][0]['set_temperature']['raw_value'] == 350
    assert s['images'][0]['attempts'][0]['result']['fields']['barrel_temperature_set_c'][0] is None


def test_manual_unit_mismatch_and_missing_path_remain_blocked():
    s = session(result())
    row = preview(s)['rows'][0]
    for path in ('/plasticizing/suck_back_position/raw_value', '/missing/value'):
        s['edits'][row['id']] = {'target': path, 'value': 80, 'confirmed': True}
        assert preview(s)['rows'][0]['status'] == 'blocked'


def test_pressure_and_holding_time_semantics():
    r = result({'stage_holding_pressure_bar': [30, 20, 10], 'stage_holding_time_s': [1, 2, 3]})
    r.update(page_type='injection_metering', profile_id='demag.injection_metering.multi_stage_holding')
    s = session(r)
    r['field_meta'] = {'stage_holding_time_s': {'entity': {'order': 'physical_stage'}}}
    p = preview(s)
    assert all(row['status'] != 'ready' for row in p['rows'][:3])
    assert all(row['status'] == 'ready' for row in p['rows'][3:])
    s['target']['holding']['time_definition'] = 'cumulative_switch_time'
    assert preview(s)['counts']['ready'] == 0


def test_unmapped_plasticizing_and_blackout_channels_remain_visible():
    p = preview(session(result({'stage_plasticizing_speed_rpm': [80, 60], 'hot_runner_sv_c': [250, None, 260], 'new_field': 20})))
    assert len(p['rows']) == 6
    assert p['counts']['ready'] == 0
    assert [r['original'] for r in p['rows'] if r['field'] == 'hot_runner_sv_c'] == [250, None, 260]


def test_mold_target_explicit_and_cross_family_conflict():
    r = result({'mold_temperature_set_c': 80})
    r['page_type'] = 'mold_temp'
    s = session(r)
    assert preview(s)['counts']['ready'] == 0
    s['images'][0]['mold_target'] = 'mold_fixed'
    p = preview(s)
    assert p['rows'][0]['target'] == '/temperature/zones/4/set_temperature/raw_value'
    assert p['counts']['ready'] == 0  # A temperature profile cannot validate a mold controller.
    a, b = result(), result()
    b['controller_family'] = 'TACT'
    assert preview(session(a, b))['counts']['ready'] == 0


def test_http_upload_review_restart_export_and_revision(tmp_path):
    async def fake(data, filename): return result()
    client = TestClient(create_app(tmp_path, fake))
    assert client.get('/').status_code == 200
    data = client.post('/api/sessions').json()
    sid = data['session']['id']
    base = f'/api/sessions/{sid}'
    assert client.post(base + '/images', files={'file': ('bad.png', b'not an image')}).status_code == 422
    data = client.post(base + '/images', files={'file': ('screen.png', png(), 'image/png')}).json()
    s = data['session']
    assert len(s['images']) == 1 and data['preview']['counts']['ready'] == 4
    duplicate = client.post(base + '/images', files={'file': ('same.png', png())}).json()
    assert len(duplicate['session']['images']) == 1
    row = data['preview']['rows'][0]
    body = {'expected_revision': s['revision'], 'target': s['target'],
            'edits': {row['id']: {'value': 355, 'confirmed': True}}, 'note': '原值误读'}
    saved = client.put(base + '/review', json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()['preview']['counts']['manual'] == 1
    assert client.put(base + '/review', json=body).status_code == 409
    other = TestClient(create_app(tmp_path, fake))
    recovered = other.get(base).json()
    assert recovered['session']['note'] == '原值误读'
    assert recovered['session']['images'][0]['attempts'][0]['result'] == result()
    archive = zipfile.ZipFile(io.BytesIO(other.get(base + '/export?bundle=true').content))
    assert 'result.json' in archive.namelist() and len(archive.namelist()) == 2
    assert json.loads(archive.read('result.json'))['session']['reviews'][0]['note'] == '原值误读'
    iid = s['images'][0]['id']
    rerun = other.post(base + f'/images/{iid}/recognize').json()
    assert len(rerun['session']['images'][0]['attempts']) == 2
    assert rerun['preview']['counts']['manual'] == 0


def test_upstream_failure_preserves_photo_and_can_retry(tmp_path):
    async def unavailable(*args): raise HTTPException(502, 'Reader offline')
    client = TestClient(create_app(tmp_path, unavailable))
    sid = client.post('/api/sessions').json()['session']['id']
    res = client.post(f'/api/sessions/{sid}/images', files={'file': ('photo.png', png())})
    assert res.status_code == 200
    assert res.json()['session']['images'][0]['attempts'][0]['error'] == 'Reader offline'
    assert len(list(tmp_path.glob('*/*.image'))) == 1


def test_access_origin_and_untrusted_edits(tmp_path):
    secured = TestClient(create_app(tmp_path, password='test-password'))
    assert secured.get('/api/sessions').status_code == 401
    assert secured.get('/api/sessions', auth=('lab', 'test-password')).status_code == 200
    client = TestClient(create_app(tmp_path))
    assert client.get('/', headers={'Host': 'attacker.example'}).status_code == 403
    assert client.post('/api/sessions', headers={'Origin': 'https://attacker.example'}).status_code == 403
    s = client.post('/api/sessions').json()['session']
    body = {'expected_revision': s['revision'], 'target': s['target'], 'edits': {'x': {'confirmed': 'false'}}}
    assert client.put(f"/api/sessions/{s['id']}/review", json=body).status_code == 422


def test_invalid_target_does_not_replace_saved_session(tmp_path):
    client = TestClient(create_app(tmp_path))
    s = client.post('/api/sessions').json()['session']
    bad = deepcopy(s['target'])
    bad['temperature'] = []
    url = f"/api/sessions/{s['id']}"
    assert client.put(url + '/review', json={'expected_revision': s['revision'], 'target': bad}).status_code == 422
    assert client.get(url).json()['session']['target'] == s['target']


def test_manual_retarget_cannot_improve_raw_mapping_metrics():
    s = session(result({'stage_plasticizing_speed_rpm': [80, 60, 40]}))
    p = preview(s)
    row = p['rows'][0]
    s['edits'][row['id']] = {'target': '/plasticizing/segments/0/screw_speed/raw_value', 'confirmed': True}
    p = preview(s)
    assert p['counts']['manual'] == 1
    assert p['raw_mapping_counts']['ready'] == 0
    assert p['automatic_parameter_data'] == s['target']
    assert p['corrected_parameter_data']['plasticizing']['segments'][0]['screw_speed']['raw_value'] == 80


def test_empty_arrays_are_not_silently_dropped():
    p = preview(session(result({'unknown_array': []})))
    assert len(p['rows']) == 1 and p['rows'][0]['status'] == 'blocked'


def test_unit_metadata_conflict_not_silently_relabelled():
    r = result()
    r['field_meta'] = {'barrel_temperature_set_c': {'unit': '°F'}}
    assert preview(session(r))['counts']['ready'] == 0
