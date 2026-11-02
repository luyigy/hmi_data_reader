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
