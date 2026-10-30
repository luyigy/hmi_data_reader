"""S01.1 authority at template selection and the real extraction boundary."""
import json
from pathlib import Path

import pytest

from page_identity import route_identities
from page_template_registry import registered_page_templates, load_template
from extract_fields import extract_one

ROOT = Path(__file__).resolve().parents[1]
BR = 'b_and_r.injection_holding.multi_stage_position_time'
TACT5 = 'tact5.process_settings.injection_holding_metering'


def anchor_only(profile):
    texts = (['射胶', '保压', '保压切换', '外部信号'] if profile == BR else
             ['VSL1', 'Pp1', 'SM', '计量前', '计量后'])
    return [dict(text=text, conf=.99, bbox=dict(x_min=10, y_min=10,
                 x_max=50, y_max=30)) for text in texts]


@pytest.mark.parametrize('profile,family,page', [(BR, 'B_AND_R', 'injection_metering'),
                                                (TACT5, 'TACT5', 'process_settings')])
def test_text_anchors_cannot_override_unknown_plugin(profile, family, page, tmp_path):
    lines = anchor_only(profile)
    assert route_identities(lines, family)['status'] == 'unknown'
    assert registered_page_templates(family, ROOT/'templates', lines=lines) == []
    assert load_template(family, page, ROOT/'templates', lines=lines) is None
    (tmp_path/'sample.ocr.json').write_text(json.dumps({'lines': lines}))
    (tmp_path/'sample.rectify.json').write_text(json.dumps({'ok': True, 'screen_size': [1000, 1000]}))
    result = extract_one('sample', tmp_path, None, None, ROOT/'templates')
    assert result['page_routing']['status'] == 'unknown'
    assert result.get('profile_id') != profile


def test_unimplemented_page_is_explicitly_unsupported():
    decision = route_identities([], profile_ids=['demag.injection_metering.multi_stage_holding'])
    assert decision['status'] == 'unsupported'
    assert decision['profile_id'] is None


def test_unknown_keeps_missing_evidence_and_controller_conflicts():
    decision = route_identities([], 'B_AND_R')
    assert decision['status'] == 'unknown'
    assert any(c['missing'] for c in decision['candidates'])


def test_confirmed_page_with_no_values_keeps_identity(tmp_path, monkeypatch):
    import extract_fields
    frozen = json.loads((ROOT/'tests/fixtures/b_and_r_stability/live_20261029_curve_context.json').read_text())['ocr_evidence']
    lines = [dict(text=l['text'], conf=l['confidence'],
                  bbox=dict(zip(('x_min', 'y_min', 'x_max', 'y_max'), l['bbox']))) for l in frozen['lines']]
    (tmp_path/'sample.ocr.json').write_text(json.dumps({'lines': lines}))
    (tmp_path/'sample.rectify.json').write_text(json.dumps({'ok': True, 'screen_size': frozen['screen_size']}))
    monkeypatch.setattr(extract_fields, 'extract_page_fields', lambda *a, **kw:
                        dict(fields=None, warnings=['TEST_VALUE_READ_FAILED'], heater_columns=0, detail={}))
    result = extract_one('sample', tmp_path, None, None, ROOT/'templates')
    assert result['page_routing']['status'] == 'matched'
    assert result['profile_id'] == BR
    assert result['fields'] is None and result['status'] == 'reject'


@pytest.mark.parametrize('status,profile,expected', [('unknown', None, False),
    ('matched', TACT5, False), ('matched', BR, True)])
def test_value_retry_cannot_change_confirmed_identity(status, profile, expected):
    from page_identity import accepts_field_retry
    first = {'page_routing': {'status': 'matched', 'profile_id': BR}}
    retry = {'fields': {'plausible': 10}, 'page_routing': {'status': status, 'profile_id': profile}}
    assert accepts_field_retry(first, retry) is expected


def test_bp_and_pb_are_not_ocr_aliases():
    frozen = json.loads((ROOT/'tests/fixtures/tact5_process_ocr.json').read_text())['lines']
    assert {'PB1', 'PB2', 'PB3'} <= {l['text'] for l in frozen}
    assert route_identities(frozen)['profile_id'] == TACT5
    switched = [{**l, 'text': l['text'].replace('PB', 'BP')} for l in frozen]
    result = route_identities(switched)
    assert result['status'] == 'unknown'
    assert any('legacy_tact_bp_labels_require_separate_profile' in c['conflicts'] for c in result['candidates'])


def test_partial_nissei_structure_cannot_be_claimed_by_lcd_fallback(tmp_path, monkeypatch):
    import extract_fields
    lines = json.loads((ROOT/'tests/fixtures/tact5_process_ocr.json').read_text())['lines']
    lines = [l for l in lines if 450 < l['bbox']['y_min'] < 600 and l['bbox']['x_min'] < 960]
    (tmp_path/'partial.ocr.json').write_text(json.dumps({'lines': lines}))
    (tmp_path/'partial.rectify.json').write_text(json.dumps({'ok': True, 'screen_size': [1418,1077]}))
    monkeypatch.setattr(extract_fields, 'is_lcd_pv_set', lambda _: True)
    result = extract_one('partial', tmp_path, None, None, ROOT/'templates')
    assert result['page_routing']['status'] == 'unknown'
    assert result.get('profile_id') != 'industrial_chiller.mold_temp.lcd_pv_set'


def test_mixed_page_identities_cannot_be_resolved_by_legacy_brand_keywords(tmp_path):
    br = json.loads((ROOT/'tests/fixtures/b_and_r_stability/live_20261029_curve_context.json').read_text())['ocr_evidence']['lines']
    ns = json.loads((ROOT/'tests/fixtures/tact5_process_ocr.json').read_text())['lines']
    lines = [dict(text=l['text'], conf=l['confidence'],
                  bbox=dict(zip(('x_min','y_min','x_max','y_max'), l['bbox']))) for l in br] + ns
    (tmp_path/'mixed.ocr.json').write_text(json.dumps({'lines': lines}))
    (tmp_path/'mixed.rectify.json').write_text(json.dumps({'ok': True, 'screen_size': [2000,2000]}))
    result = extract_one('mixed', tmp_path, None, None, ROOT/'templates')
    assert result['page_routing']['status'] == 'ambiguous'
    assert result.get('profile_id') not in {BR, TACT5}
    assert not result.get('fields')
