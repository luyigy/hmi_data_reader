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


@pytest.mark.parametrize('page', [BR])
def test_real_pages_route_without_field_extraction(page, monkeypatch):
    import extract_fields
    monkeypatch.setattr(extract_fields, 'extract_page_fields', lambda *a, **kw: pytest.fail('routing called extraction'))
    result = route_identities(real_lines(page))
    assert result['status'] == 'matched' and result['profile_id'] == page
    assert result['candidates'][0]['evidence']










@pytest.mark.parametrize('page', [BR])
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
