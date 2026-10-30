"""S01: independent routing on frozen real OCR and labeled perturbations."""
import copy
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from page_identity import route_identities
from page_template_registry import registered_page_templates

BR = 'b_and_r.injection_holding.multi_stage_position_time'
TACT5 = 'tact5.process_settings.injection_holding_metering'


def real_lines(page):
    if page == BR:
        return json.loads((ROOT / 'tests/fixtures/b_and_r_stability/live_20261029_curve_context.json').read_text())['ocr_evidence']['lines']
    return json.loads((ROOT / 'tests/fixtures/tact5_process_ocr.json').read_text())['lines']


@pytest.mark.parametrize('page', [BR, TACT5])
def test_real_pages_route_without_field_extraction(page, monkeypatch):
    import extract_fields
    monkeypatch.setattr(extract_fields, 'extract_page_fields', lambda *a, **kw: pytest.fail('routing called extraction'))
    result = route_identities(real_lines(page))
    assert result['status'] == 'matched' and result['profile_id'] == page
    assert result['candidates'][0]['evidence']


def test_fill_block_only_retains_family_candidate_not_exact_generation():
    lines = [l for l in real_lines(TACT5) if 450 < l['bbox']['y_min'] < 600 and l['bbox']['x_min'] < 960]
    result = route_identities(lines)
    assert result['status'] == 'unknown' and result['profile_id'] is None
    assert result['candidates'][0]['evidence'] == ['nissei_v_sv_sm_staggered_block']
    assert 'tact5_generation_discriminator' in result['candidates'][0]['missing']
    assert registered_page_templates('unknown', ROOT / 'templates', lines=lines) == []


@pytest.mark.parametrize('scale,dx,dy', [(1, 0, 0), (.7, 20, -500), (2, 300, 800)])
def test_metering_local_block_routes_after_crop_and_scale(scale, dx, dy):
    lines = copy.deepcopy([l for l in real_lines(TACT5)
        if 530 < l['bbox']['y_min'] < 740 and l['bbox']['x_min'] > 980])
    for line in lines:
        b = line['bbox']
        line['bbox'] = [b['x_min']*scale+dx, b['y_min']*scale+dy,
                        b['x_max']*scale+dx, b['y_max']*scale+dy]
    assert route_identities(lines)['profile_id'] == TACT5
    assert [t['profile_id'] for t in registered_page_templates('unknown', ROOT / 'templates', lines=lines)] == [TACT5]


def test_old_tact_labels_veto_tact5_even_with_text_anchors():
    lines = copy.deepcopy(real_lines(TACT5))
    for line in lines:
        if line['text'].startswith('PB'):
            line['text'] = line['text'].replace('PB', 'BP')
    result = route_identities(lines)
    assert result['profile_id'] is None
    assert result['candidates'][0]['conflicts']
    assert registered_page_templates('unknown', ROOT / 'templates', lines=lines) == []


def test_mixed_real_pages_are_ambiguous_not_first_match_wins():
    result = route_identities(real_lines(BR) + real_lines(TACT5))
    assert result['status'] == 'ambiguous' and result['profile_id'] is None
    assert {c['profile_id'] for c in result['candidates'] if c['matched']} == {BR, TACT5}


@pytest.mark.parametrize('page', [BR, TACT5])
def test_numeric_values_do_not_decide_page_identity(page):
    lines = copy.deepcopy(real_lines(page))
    import re
    for line in lines:
        if re.fullmatch(r'\d+\.\d+', line['text']):
            line['text'] = '0.0'
    assert route_identities(lines)['profile_id'] == page
    numeric_only = [l for l in lines if re.fullmatch(r'\d+\.\d+', l['text'])]
    assert route_identities(numeric_only)['status'] == 'unknown'


def test_br_route_does_not_require_residual_speed_cell():
    lines = copy.deepcopy([l for l in real_lines(BR) if 440 <= l['bbox'][1] < 750])
    # Remove the extra leftmost speed token: table identity remains the same,
    # independently of whether an extractor can establish enabled stages.
    lines = [l for l in lines if not (l['text'] == '0.0' and 530 < l['bbox'][1] < 560)]
    assert route_identities(lines)['profile_id'] == BR


@pytest.mark.parametrize('page,family', [(BR, 'TACT5'), (TACT5, 'B_AND_R')])
def test_known_foreign_controller_cannot_be_overridden(page, family):
    assert route_identities(real_lines(page), family)['profile_id'] is None


@pytest.mark.parametrize('fixture', [
    'tests/fixtures/demag_injection_z002_wehdt_ocr.json',
    'tests/fixtures/demag_holding_z002_ocr.json',
    'tests/fixtures/demag_metering_z002_ocr.json',
    'tests/fixtures/yizumi_30_development_ocr.json',
    'datasets/r6_arburg/development.ocr.json',
    'datasets/r6_arburg/retained.ocr.json',
])
def test_other_real_page_layouts_are_not_forced_into_first_two_plugins(fixture):
    lines = json.loads((ROOT / fixture).read_text())['lines']
    assert route_identities(lines)['status'] == 'unknown'
