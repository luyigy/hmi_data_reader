"""Current curve-context photo and guarded, plugin-local title recovery."""
import copy
import hashlib
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from extract_families.b_and_r_headers import section_headers
from extract_families.b_and_r_injection import extract_injection_b_and_r
from extractor_registry import page_identity_match
from page_template_registry import registered_page_templates, resolve_page_template
from rectify import rectify

PID = 'b_and_r.injection_holding.multi_stage_position_time'


@pytest.fixture
def evidence():
    directory = ROOT / 'tests/fixtures/b_and_r_stability'
    frozen = json.loads((directory / 'live_20261029_curve_context.json').read_text())
    photo = directory / 'live_20261029_curve_context.jpg'
    assert hashlib.sha256(photo.read_bytes()).hexdigest() == frozen['original_sha256']
    return photo, frozen['ocr_evidence']


def test_curve_photo_routes_to_existing_profile_and_keeps_18_enabled_fields(evidence, tmp_path):
    photo, ocr = evidence
    page, source, template = resolve_page_template('new_photo', ocr['lines'], 'B_AND_R', ROOT / 'templates')
    assert page == 'injection_metering'
    assert source == 'template_anchors'
    assert template['profile_id'] == PID
    image = tmp_path / 'rectified.png'
    assert rectify(photo, image)['screen_size'] == ocr['screen_size']
    width, height = ocr['screen_size']
    tokens = [dict(text=line['text'], conf=line['confidence'], bbox=line['bbox'],
        x=(line['bbox'][0]+line['bbox'][2])/2/width,
        y=(line['bbox'][1]+line['bbox'][3])/2/height, line_index=index)
        for index, line in enumerate(ocr['lines'])]
    result = extract_injection_b_and_r(tokens, template, image_path=image)
    assert result['warnings'] == []
    assert result['detail']['verified_layout_counts'] == {'injection': 4, 'holding': 2}
    staged = [f for f in result['detail']['page_observations']['fields'] if f['stage']]
    assert len(staged) == 18 and all(f['state'] == 'enabled' for f in staged)
    assert result['fields']['injection_velocity_pct'] == [65, 42, 65, 35]
    assert result['fields']['holding_time_s'] == [1.5, 1]
    assert next(line['text'] for line in ocr['lines'] if line['text'] == '保压训换') == '保压训换'


@pytest.mark.parametrize('title', ['保压切换', '保压奶换', '保压训换', '保压切挟'])
def test_one_substitution_uses_position_evidence_instead_of_typo_list(evidence, title):
    _, ocr = evidence
    lines = copy.deepcopy(ocr['lines'])
    next(line for line in lines if line['text'] == '保压训换')['text'] = title
    assert section_headers(lines) is not None
    assert [t['profile_id'] for t in registered_page_templates('B_AND_R', ROOT / 'templates', lines=lines)] == [PID]


@pytest.mark.parametrize('fault', ['missing_title', 'two_errors', 'sidebar', 'ambiguous',
                                  'low_confidence', 'missing_other_anchor'])
def test_incomplete_or_ambiguous_headers_cannot_recover_template(evidence, fault):
    _, ocr = evidence
    lines = copy.deepcopy(ocr['lines'])
    switch = next(line for line in lines if line['text'] == '保压训换')
    if fault == 'missing_title':
        lines.remove(switch)
    elif fault == 'two_errors':
        switch['text'] = '保压设置'
    elif fault == 'sidebar':
        switch['bbox'] = [0, 1087, 76, 1113]
    elif fault == 'ambiguous':
        lines.append({**switch, 'bbox': [608, 1060, 684, 1080]})
    elif fault == 'low_confidence':
        switch['confidence'] = .3
    else:
        lines = [line for line in lines if line['text'] != '外部信号']
    # With the complete injection fingerprint still present the identity remains
    # known, even though the switch region cannot be extracted safely.
    assert [t['profile_id'] for t in registered_page_templates('B_AND_R', ROOT / 'templates', lines=lines)] == [PID]
    if fault != 'missing_other_anchor':
        assert section_headers(lines) is None


def test_title_recovery_does_not_extend_other_profiles(evidence):
    _, ocr = evidence
    assert page_identity_match({'profile_id': 'other.brand.page'}, ocr['lines']) is False
    assert registered_page_templates('TACT', ROOT / 'templates', lines=ocr['lines']) == []


@pytest.mark.parametrize('scale,dx,dy', [(1, 0, -420), (.6, 100, 30), (2, -50, 800)])
def test_visible_injection_table_identifies_template_without_full_screen(evidence, scale, dx, dy):
    _, ocr = evidence
    lines = copy.deepcopy([line for line in ocr['lines'] if 440 <= line['bbox'][1] < 750])
    for line in lines:
        x0, y0, x1, y1 = line['bbox']
        line['bbox'] = [x0*scale+dx, y0*scale+dy, x1*scale+dx, y1*scale+dy]
    # Family is also unknown: the local layout, not a filename or full-screen title, routes it.
    assert [t['profile_id'] for t in registered_page_templates('unknown', ROOT / 'templates', lines=lines)] == [PID]


@pytest.mark.parametrize('case', ['holding_only', 'numbers_only', 'missing_value_row', 'wrong_stagger'])
def test_insufficient_or_contradictory_local_fingerprints_remain_unknown(evidence, case):
    _, ocr = evidence
    lines = copy.deepcopy([line for line in ocr['lines'] if 440 <= line['bbox'][1] < 750])
    if case == 'holding_only':
        lines = [line for line in ocr['lines'] if 790 <= line['bbox'][1] < 1080]
    elif case == 'numbers_only':
        lines = [line for line in lines if line['text'] not in ('射胶', '速度', '压力', '位置', '时间')]
    elif case == 'missing_value_row':
        lines = [line for line in lines if not 590 <= line['bbox'][1] < 650]
    else:
        for line in lines:
            if 660 <= line['bbox'][1] < 700 and line['text'] not in ('位置', '射胶销助'):
                line['bbox'][0] += 80
                line['bbox'][2] += 80
    assert registered_page_templates('unknown', ROOT / 'templates', lines=lines) == []


def test_routing_does_not_execute_value_extractor(evidence, monkeypatch):
    import extract_families.b_and_r_injection as extractor
    _, ocr = evidence

    def forbidden(*args, **kwargs):
        raise AssertionError('Page identity must not call value extraction')

    monkeypatch.setattr(extractor, 'extract_injection_b_and_r', forbidden)
    assert [t['profile_id'] for t in registered_page_templates('unknown', ROOT / 'templates', lines=ocr['lines'])] == [PID]


def test_matched_page_identity_survives_incomplete_field_extraction(evidence, tmp_path):
    from extract_fields import extract_one
    _, ocr = evidence
    lines = [dict(text=line['text'], conf=line['confidence'],
        bbox=dict(zip(('x_min', 'y_min', 'x_max', 'y_max'), line['bbox'])))
        for line in ocr['lines'] if 440 <= line['bbox'][1] < 750]
    (tmp_path / 'crop.ocr.json').write_text(json.dumps({'lines': lines}))
    (tmp_path / 'crop.rectify.json').write_text(json.dumps({'ok': True, 'screen_size': ocr['screen_size']}))
    result = extract_one('crop', tmp_path, None, None, ROOT / 'templates')
    assert result['provenance']['page_source'] == 'template_anchors'
    assert result['profile_id'] == PID
    assert result['hmi_variant'] == 'multi_stage_position_time'
    # Identity is known, but absent holding/switch values are still not invented.
    assert result['status'] == 'reject'
    assert result['fields'] is None
