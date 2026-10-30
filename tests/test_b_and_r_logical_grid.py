"""M1 layout contract: predictions, observations, raw readings and safe mappings."""
import copy
import json
from pathlib import Path
import sys

import cv2
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from export_page_package import export_page_package
import extract_families.b_and_r_injection as plugin
from extract_families.b_and_r_holding_layout import build_holding_layout
from rectify import rectify


@pytest.fixture
def photo(tmp_path):
    fixture = ROOT/'tests/fixtures/b_and_r_holding_recovery'
    image = tmp_path/'page.png'
    rectify(fixture/'pasted_original.png', image)
    tokens = json.loads((fixture/'pasted_ocr.json').read_text())['tokens']
    template = export_page_package('b_and_r.injection_holding.multi_stage_position_time', '0.1.1')['template']
    return image, tokens, template


def test_all_speed_borders_missing_still_has_a_verified_column_axis(photo, monkeypatch):
    image, tokens, template = photo
    before = plugin.extract_injection_b_and_r(tokens, template, image)
    speed = before['detail']['physical_rows']['holding'][0]
    boxes = [b for b in plugin.bordered_cells(cv2.imread(str(image), 0)) if b not in speed]
    monkeypatch.setattr(plugin, 'bordered_cells', lambda gray: boxes)
    result = plugin.extract_injection_b_and_r(tokens, template, image)
    assert result['fields'] == before['fields']
    cells = result['detail']['holding_layout']['cells']
    assert all(not c['observed_border_ids'] and c['mapping_status'] == 'verified'
               for c in cells if c['row_key'] == 'velocity')


def test_no_borders_preserves_grid_but_does_not_invent_active_stage_count(photo, monkeypatch):
    image, tokens, template = photo
    clean = plugin.extract_injection_b_and_r(tokens, template, image)
    lo = clean['detail']['section_y']['holding']*cv2.imread(str(image), 0).shape[0]
    boxes = [b for b in plugin.bordered_cells(cv2.imread(str(image), 0)) if b[3] < lo]
    monkeypatch.setattr(plugin, 'bordered_cells', lambda gray: boxes)
    result = plugin.extract_injection_b_and_r(tokens, template, image)
    layout = result['detail']['holding_layout']
    assert len(layout['cells']) == 7
    assert layout['stage_identity_verified']
    assert layout['active_stages'] == 2
    assert layout['state_evidence'] == ['two_labeled_ocr_row_extents']
    pressure = next(c for c in layout['cells'] if c['row_key'] == 'pressure' and c['stage_id'] == 1)
    assert pressure['raw_reading'] == ['45.00']
    assert not pressure['observed_border_ids']
    assert pressure['predicted_bbox']
    assert result['fields']['holding_pressure_bar'] == [45., 90.]
    # Remove both lower rows' observed readings too: predictions still exist,
    # but no automatic enabled-stage count may be inferred from those alone.
    missing = [t for t in tokens if not (t['text'] in {'45.00', '90.00', '2.00'})]
    pending = plugin.extract_injection_b_and_r(missing, template, image)
    assert pending['detail']['holding_layout']['active_stages'] is None
    assert pending['fields']['holding_stages'] is None


@pytest.mark.parametrize('damage', ['duplicate', 'missing', 'malformed', 'low_confidence'])
def test_cell_reading_failure_does_not_erase_other_fields(photo, damage):
    image, tokens, template = photo
    tokens = copy.deepcopy(tokens)
    target = next(t for t in tokens if t['text'] == '45.00')
    if damage == 'duplicate':
        tokens.append({**target, 'text': '46.00', 'line_index': 999})
    elif damage == 'missing':
        tokens.remove(target)
    elif damage == 'malformed':
        target['text'] = '45.OO'
    else:
        target['conf'] = .2
    result = plugin.extract_injection_b_and_r(tokens, template, image)
    layout = result['detail']['holding_layout']
    cell = next(c for c in layout['cells'] if c['row_key'] == 'pressure' and c['stage_id'] == 1)
    reading = next(c for c in result['detail']['holding_fields']
                   if c['row_key'] == 'pressure' and c['stage_id'] == 1)
    assert result['fields']['holding_stages'] == 2
    assert result['fields']['holding_time_s'] == [2., 2.]
    assert result['fields']['holding_velocity_pct'] == [5., 10.]
    if damage == 'low_confidence':
        assert cell['raw_reading'] == ['45.00'] and cell['ocr_confidences'] == [.2]
        assert cell['stage_identity_verified']
        fact = next(f for f in result['detail']['page_observations']['fields'] if f['label'] == '保压压力1')
        assert 'low_confidence' in fact['reasons']
        assert reading['reading_status'] == 'uncertain' and not reading['automatic_eligible']
    else:
        assert result['fields']['holding_pressure_bar'] is None
        assert cell['raw_reading'] == {'duplicate': ['45.00', '46.00'], 'missing': [], 'malformed': ['45.OO']}[damage]
        other = next(f for f in result['detail']['page_observations']['fields'] if f['label'] == '保压压力2')
        assert other['value'] == 90.
        assert reading['reading_status'] == {'duplicate': 'conflict', 'missing': 'missing', 'malformed': 'uncertain'}[damage]
        assert not reading['automatic_eligible']


def test_bare_numbers_cannot_establish_row_identity(photo):
    image, tokens, template = photo
    numeric = [t for t in tokens if t['text'].replace('.', '').isdigit()]
    layout, rows = build_holding_layout(numeric, [], 0, cv2.imread(str(image), 0).shape[0],
                                        (1400, 1168), cv2.imread(str(image), 0))
    assert not layout.stage_identity_verified
    assert layout.active_stages is None
    assert layout.ocr_observations


def test_single_value_with_labels_is_insufficient_without_column_evidence(photo):
    image, tokens, template = photo
    only = [t for t in tokens if t['text'] in {'压力', '时间', '45.00'}]
    gray = cv2.imread(str(image), 0)
    result, _ = build_holding_layout(only, [], 0, gray.shape[0], (gray.shape[1], gray.shape[0]), gray)
    assert result.active_stages is None
    assert result.conflicts


def test_missing_all_holding_numbers_still_builds_structure_from_labels_and_borders(photo):
    image, tokens, template = photo
    clean = plugin.extract_injection_b_and_r(tokens, template, image)
    lo, hi = (clean['detail']['section_y'][key] for key in ('holding', 'switch'))
    tokens = [t for t in tokens if not (lo < t['y'] < hi and t['text'].replace('.', '').isdigit())]
    result = plugin.extract_injection_b_and_r(tokens, template, image)
    layout = result['detail']['holding_layout']
    assert layout['stage_identity_verified']
    assert layout['active_stages'] == 2
    assert len(layout['cells']) == 7
    assert all(not c['raw_reading'] for c in layout['cells'])
    assert all(c['reading_status'] == 'missing' and not c['automatic_eligible']
               for c in result['detail']['holding_fields'])
    assert result['fields']['holding_pressure_bar'] is None


def test_joint_coordinates_are_translation_invariant_and_do_not_rewrite_ocr(photo):
    image, tokens, template = photo
    gray = cv2.imread(str(image), 0)
    clean = plugin.extract_injection_b_and_r(tokens, template, image)
    lo = clean['detail']['section_y']['holding']*gray.shape[0]
    hi = clean['detail']['section_y']['switch']*gray.shape[0]
    boxes = plugin.bordered_cells(gray)
    reference = clean['detail']['physical_rows']['injection'][0][0]
    first, _ = build_holding_layout(tokens, boxes, lo, hi, (gray.shape[1], gray.shape[0]), gray, reference)
    moved = copy.deepcopy(tokens)
    dx, dy = 137, 79
    canvas = cv2.copyMakeBorder(gray, dy, 0, dx, 0, cv2.BORDER_CONSTANT, value=235)
    translate = lambda b: [b[0]+dx, b[1]+dy, b[2]+dx, b[3]+dy]
    for t in moved:
        t['bbox'] = translate(t['bbox'])
        t['x'] = (t['bbox'][0]+t['bbox'][2])/2/canvas.shape[1]
        t['y'] = (t['bbox'][1]+t['bbox'][3])/2/canvas.shape[0]
    second, _ = build_holding_layout(moved, [translate(b) for b in boxes], lo+dy, hi+dy,
                                     (canvas.shape[1], canvas.shape[0]), canvas, translate(reference))
    assert second.stage_identity_verified and second.active_stages == first.active_stages
    assert [(c.row_key, c.stage_id, c.raw_reading, c.mapping_status) for c in first.cells] == [
        (c.row_key, c.stage_id, c.raw_reading, c.mapping_status) for c in second.cells]
    assert [t['text'] for t in moved] == [t['text'] for t in tokens]


def test_row_label_conflict_does_not_override_page_identity(photo):
    image, tokens, template = photo
    tokens = copy.deepcopy(tokens)
    next(t for t in tokens if t['text'] == '压力' and t['y'] > .5)['text'] = '时间'
    result = plugin.extract_injection_b_and_r(tokens, template, image)
    layout = result['detail']['holding_layout']
    assert any(c['reasons'] for c in layout['cells'])
    assert any(a['conflicts'] for a in layout['row_axes'])
    assert result['fields']['holding_pressure_bar'] is None
    assert result['detail']['page_variant'] == 'multi_stage_position_time'


def test_misread_stage_header_cannot_override_verified_sibling_geometry(photo, monkeypatch):
    image, tokens, template = photo
    tokens = copy.deepcopy(tokens)
    clean = plugin.extract_injection_b_and_r(tokens, template, image)
    speed = clean['detail']['physical_rows']['holding'][0]
    gray = cv2.imread(str(image), 0)
    boxes = [b for b in plugin.bordered_cells(gray) if b != speed[0]]
    tokens = [t for t in tokens if not (t['text'] == '5.0' and t['y'] > .5)]
    # Fault injection: the remaining physical stage 2 is falsely printed/read as 1.
    x = (speed[1][0]+speed[1][2])/2
    y = (clean['detail']['section_y']['holding']*gray.shape[0]+speed[1][1])/2
    tokens.append(dict(text='1', conf=.99, bbox=[x-8, y-8, x+8, y+8],
                       x=x/gray.shape[1], y=y/gray.shape[0]))
    monkeypatch.setattr(plugin, 'bordered_cells', lambda gray: boxes)
    result = plugin.extract_injection_b_and_r(tokens, template, image)
    layout = result['detail']['holding_layout']
    assert 'SIBLING_COLUMN_CONFLICT' in layout['conflicts']
    assert not layout['stage_identity_verified']
    assert result['fields']['holding_pressure_bar'] is None
    assert all(not c['automatic_eligible'] for c in result['detail']['holding_fields'])
