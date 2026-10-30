"""Real photographs with frozen OCR; border removals/shifts are fault injection."""
import copy
import hashlib
import json
import sys
from pathlib import Path

import cv2
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import extract_families.b_and_r_injection as extraction
from export_page_package import export_page_package
from rectify import rectify
from verify_b_and_r_stability import MANIFEST, load_sample


@pytest.fixture
def current_photo(tmp_path):
    folder = ROOT / 'tests/fixtures/b_and_r_holding_recovery'
    frozen = json.loads((folder / 'ocr.json').read_text())
    assert hashlib.sha256((folder / 'original.jpg').read_bytes()).hexdigest() == frozen['original_sha256']
    image = tmp_path / 'rectified.png'
    assert rectify(folder / 'original.jpg', image)['ok']
    template = export_page_package('b_and_r.injection_holding.multi_stage_position_time', '0.1.1')['template']
    return image, frozen['tokens'], template


@pytest.fixture
def three_stage_photo(tmp_path):
    sample = next(s for s in json.loads(MANIFEST.read_text())['samples'] if 'rank01' in s['id'])
    image, tokens, truth = load_sample(sample, tmp_path)
    template = export_page_package('b_and_r.injection_holding.multi_stage_position_time', '0.1.1')['template']
    return image, tokens, truth, template


def test_real_missed_border_recovers_pressure_and_time_without_correcting_ocr(current_photo):
    image, tokens, template = current_photo
    result = extraction.extract_injection_b_and_r(tokens, template, image)
    assert result['fields']['holding_pressure_bar'] == [45., 90.]
    assert result['fields']['holding_time_s'] == [2., 2.]
    assert result['fields']['holding_stages'] == 2
    recovered = [c for c in result['detail']['holding_layout']['cells'] if not c['observed_border_ids']]
    assert len(recovered) == 1
    assert recovered[0]['row_key'] == 'pressure' and recovered[0]['stage_id'] == 1
    assert recovered[0]['predicted_bbox'] and recovered[0]['evidence']
    assert recovered[0]['mapping_status'] == 'verified'
    # Keep OCR defects visible; geometry must never manufacture/correct numbers.
    assert result['fields']['holding_velocity_pct'] == [6., 10.]
    assert result['fields']['injection_velocity_pct'] is None
    assert result['detail']['cell_readings']['injection']['velocity'][1]['value'] is None
    reading = result['detail']['cell_readings']['holding']['pressure'][0]
    token = next(t for t in tokens if t['text'] == '45.00')
    assert reading == dict(value=45., confidence=token['conf'], stage=1, identity_verified=True)


@pytest.mark.parametrize('missing,shift,recover', [
    ([(1, 0)], False, True),  # First pressure cell, two remaining neighbours.
    ([(1, 1)], False, True),  # Middle pressure cell: do not compact stage 3.
    ([(1, 0), (1, 2)], False, True),  # Two borders, supported by middle neighbour.
    ([(2, 0)], False, True),  # Recover time from the complete pressure row.
    ([(2, 1)], False, True),
    ([(2, 0), (2, 2)], False, True),
    ([(1, 1), (2, 1)], False, True),  # Labels/OCR keep both row identities without full rows.
    ([(0, 0)], False, True),  # First speed OCR + verified sibling preserve stage one.
    ([], True, False),  # Half-column pressure displacement.
    ([(1, 0), (1, 1), (1, 2)], False, True),  # Complete pressure readings need no border.
])
def test_real_three_stage_border_faults(three_stage_photo, monkeypatch, missing, shift, recover):
    image, tokens, truth, template = three_stage_photo
    clean = extraction.extract_injection_b_and_r(tokens, template, image)
    holding = clean['detail']['physical_rows']['holding']
    detector = extraction.bordered_cells
    removed = [holding[row][column] for row, column in missing]
    boxes = [b for b in detector(cv2.imread(str(image), 0)) if b not in removed]
    if shift:
        target = holding[1][1]
        offset = round((target[2]-target[0])*.5)
        boxes = [[b[0]+offset, b[1], b[2]+offset, b[3]] if b == target else b for b in boxes]
    monkeypatch.setattr(extraction, 'bordered_cells', lambda gray: boxes)
    result = extraction.extract_injection_b_and_r(copy.deepcopy(tokens), template, image)
    if recover:
        assert result['fields'] == truth
        predicted = [c for c in result['detail']['holding_layout']['cells'] if not c['observed_border_ids']]
        assert len(predicted) == len(missing)
        assert all(c['mapping_status'] == 'verified' for c in predicted)
        for row in result['detail']['cell_readings']['holding'].values():
            assert all(cell['identity_verified'] for cell in row)
    else:
        assert result['fields']['holding_pressure_bar'] is None
        assert result['fields']['holding_time_s'] == truth['holding_time_s']
        assert result['fields']['holding_stages'] == truth['holding_stages']
        # Preserve actual OCR readings, without assigning an unproved stage.
        facts = result['detail']['ocr_rows']['holding']
        assert any(cell['value'] == truth['holding_pressure_bar'][0] for row in facts for cell in row)
        assert all(cell['stage'] is None and not cell['identity_verified'] for row in facts for cell in row)
        assert not any(f['section'] == 'holding' and f['label'].startswith('保压压力')
                       for f in result['detail']['page_observations']['fields'])
        assert any('OFF_AXIS_BORDER' in c['reasons'] for c in result['detail']['holding_layout']['cells'])


def test_conflicting_stage_number_blocks_reconstruction(current_photo):
    image, tokens, template = current_photo
    tokens = copy.deepcopy(tokens)
    # The verified injection sibling is the identity reference in this photo.
    next(t for t in tokens if t['text'] == '3')['text'] = '2'
    result = extraction.extract_injection_b_and_r(tokens, template, image)
    assert result['fields']['holding_pressure_bar'] is None
    assert not result['detail']['holding_layout']['stage_identity_verified']
    assert all(c['mapping_status'] == 'needs_review' for c in result['detail']['holding_layout']['cells'])
    # Unverified injection mappings preserve readings and confidence for review.
    cells = result['detail']['cell_readings']['injection']['pressure']
    assert [cell['value'] for cell in cells] == [110., 120., 120., 100.]
    assert all(cell['confidence'] > 0 and cell['stage'] is None
               and not cell['identity_verified'] for cell in cells)


def test_missing_numeric_ocr_does_not_change_reconstruction(current_photo):
    image, tokens, template = current_photo
    tokens = [t for t in tokens if t['text'] != '45.00']
    result = extraction.extract_injection_b_and_r(tokens, template, image)
    assert result['fields']['holding_stages'] == 2
    assert result['fields']['holding_pressure_bar'] is None
    assert result['detail']['raw_rows']['holding']['pressure'] == [None, 90.]
    assert result['fields']['holding_time_s'] == [2., 2.]
    assert sum(not c['observed_border_ids'] for c in result['detail']['holding_layout']['cells']) == 1
