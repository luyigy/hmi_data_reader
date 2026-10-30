"""B&R layout evidence, independent of the OCR count and image contrast."""
import copy
import hashlib
import json
import sys
from pathlib import Path

import cv2
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

from export_page_package import export_page_package
from extract_families.b_and_r_injection import extract_injection_b_and_r
from extract_families.b_and_r_layout import infer_active_stages
from extract_families.b_and_r_page_observations import _visual_active_count
from rectify import rectify

PID = 'b_and_r.injection_holding.multi_stage_position_time'


@pytest.fixture
def current_photo(tmp_path):
    directory = ROOT / 'tests/fixtures/b_and_r_stability'
    frozen = json.loads((directory / 'live_20261029_low_contrast.json').read_text())
    original = directory / 'live_20261029_low_contrast.jpg'
    assert hashlib.sha256(original.read_bytes()).hexdigest() == frozen['original_sha256']
    image = tmp_path / 'rectified.png'
    meta = rectify(original, image)
    evidence = frozen['ocr_evidence']
    assert meta['screen_size'] == evidence['screen_size']
    width, height = evidence['screen_size']
    tokens = [dict(text=line['text'], conf=line['confidence'], bbox=line['bbox'],
                   x=(line['bbox'][0]+line['bbox'][2])/2/width,
                   y=(line['bbox'][1]+line['bbox'][3])/2/height, line_index=index)
              for index, line in enumerate(evidence['lines'])]
    template = export_page_package(PID, '0.1.2')['template']
    return image, tokens, template


@pytest.mark.parametrize('sizes,expected', [((5, 4, 4), 4), ((3, 2, 2), 2),
    ((2, 1, 1), 1), ((4, 3, 2), None), ((3, 3, 3), None), ((1, 0, 0), None)])
def test_only_complete_three_row_structure_has_a_count(sizes, expected):
    # These lists represent independently detected physical boxes, not OCR tokens.
    rows = [[[100-stage*20, row*10, 115-stage*20, row*10+8]
             for stage in range(size)] for row, size in enumerate(sizes)]
    assert infer_active_stages(rows) == expected


def test_current_live_ocr_enables_18_staged_fields_without_gray_boundary(current_photo):
    image, tokens, template = current_photo
    result = extract_injection_b_and_r(tokens, template, image_path=image)
    detail = result['detail']
    assert detail['verified_layout_counts'] == {'injection': 4, 'holding': 2}
    assert detail['stage_identity_verified'] == {'injection': True, 'holding': True}
    assert {key: list(map(len, rows)) for key, rows in detail['physical_rows'].items()} == {
        'injection': [5, 4, 4], 'holding': [3, 2, 2]}
    gray = cv2.imread(str(image), 0)
    assert all(_visual_active_count(rows[0], gray) is None for rows in detail['physical_rows'].values())
    staged = [f for f in detail['page_observations']['fields'] if f['stage']]
    assert len(staged) == 18
    assert all(f['state'] == 'enabled' and f['state_basis'] == 'verified_physical_layout'
               and not f['reasons'] for f in staged)


@pytest.mark.parametrize('kind', ['missing', 'duplicate', 'low_confidence'])
def test_bad_value_cannot_shift_other_stages_or_erase_layout_evidence(current_photo, kind):
    image, tokens, template = current_photo
    clean = extract_injection_b_and_r(tokens, template, image_path=image)
    target = next(f for f in clean['detail']['page_observations']['fields'] if f['label'] == '射胶速度2')
    tokens = copy.deepcopy(tokens)
    token = next(t for t in tokens if t['bbox'] == target['bbox'])
    if kind == 'missing':
        tokens.remove(token)
    elif kind == 'duplicate':
        tokens.append({**token, 'text': '43.0'})
    else:
        token['conf'] = .3
    result = extract_injection_b_and_r(tokens, template, image_path=image)
    assert result['detail']['verified_layout_counts']['injection'] == 4
    values = result['detail']['raw_rows']['injection']['velocity']
    assert values[2:] == [65, 35, 0]
    if kind == 'low_confidence':
        field = next(f for f in result['detail']['page_observations']['fields'] if f['label'] == '射胶速度2')
        assert field['state'] == 'enabled'
        assert 'low_confidence' in field['reasons']
    else:
        assert values[1] is None
        assert not any(f['label'] == '射胶速度2' for f in result['detail']['page_observations']['fields'])


def test_positive_gray_conflict_rejects_layout(current_photo, monkeypatch):
    import extract_families.b_and_r_injection as plugin
    image, tokens, template = current_photo
    monkeypatch.setattr(plugin, '_visual_active_count', lambda cells, gray: 1)
    result = plugin.extract_injection_b_and_r(tokens, template, image_path=image)
    assert result['detail']['verified_layout_counts'] == {'injection': 4, 'holding': 2}
    assert all(f['state'] == 'enabled' for f in result['detail']['page_observations']['fields'] if f['stage'])
    assert 'STAGE_GRAYSCALE_CONFLICT(injection,layout=4,gray=1)' in result['warnings']


@pytest.mark.parametrize('row_indexes', [(2,), (1, 2)])
def test_erased_rightmost_cells_do_not_become_shorter_active_table(current_photo, tmp_path, row_indexes):
    image, tokens, template = current_photo
    clean = extract_injection_b_and_r(tokens, template, image_path=image)
    damaged = cv2.imread(str(image))
    for row in row_indexes:
        x0, y0, x1, y1 = clean['detail']['physical_rows']['injection'][row][0]
        damaged[y0-4:y1+4, x0-4:x1+4] = 240
    target = tmp_path / 'missing-cells.png'
    cv2.imwrite(str(target), damaged)
    result = extract_injection_b_and_r(tokens, template, image_path=target)
    assert 'injection' not in result['detail']['verified_layout_counts']
    assert not any(f['stage'] and f['section'] == 'injection' and f['state'] == 'enabled'
                   for f in result['detail']['page_observations']['fields'])


def test_legacy_profile_does_not_get_new_structural_enable_rule(current_photo):
    image, tokens, template = current_photo
    template = {**template, 'profile_id': 'legacy_b_and_r'}
    result = extract_injection_b_and_r(tokens, template, image_path=image)
    assert result['detail']['verified_layout_counts'] == {}
    assert 'page_observations' not in result['detail']


def test_nonzero_residual_is_a_conflict_not_an_extra_enabled_stage(current_photo):
    image, tokens, template = current_photo
    clean = extract_injection_b_and_r(tokens, template, image_path=image)
    residual = next(f for f in clean['detail']['raw_page_observations']['fields']
                    if f['label'] == '射胶速度5')
    tokens = copy.deepcopy(tokens)
    next(t for t in tokens if t['bbox'] == residual['bbox'])['text'] = '10.0'
    result = extract_injection_b_and_r(tokens, template, image_path=image)
    assert 'injection' not in result['detail']['verified_layout_counts']
    assert 'STAGE_EVIDENCE_CONFLICT(injection)' in result['warnings']
    assert not any(f['section'] == 'injection' and f['state'] == 'enabled'
                   for f in result['detail']['page_observations']['fields'])


def test_zero_active_value_does_not_override_physical_stage_count(current_photo):
    image, tokens, template = current_photo
    clean = extract_injection_b_and_r(tokens, template, image_path=image)
    target = next(f for f in clean['detail']['page_observations']['fields']
                  if f['label'] == '保压时间2')
    tokens = copy.deepcopy(tokens)
    next(t for t in tokens if t['bbox'] == target['bbox'])['text'] = '0.00'
    result = extract_injection_b_and_r(tokens, template, image_path=image)
    assert result['fields']['holding_stages'] == 2
    field = next(f for f in result['detail']['page_observations']['fields']
                 if f['label'] == '保压时间2')
    assert field['value'] == 0
    assert field['state'] == 'enabled'
