"""Actual browser clipboard PNG, with three contours rejected by the public detector."""
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


@pytest.fixture
def pasted(tmp_path):
    folder = ROOT / 'tests/fixtures/b_and_r_holding_recovery'
    frozen = json.loads((folder / 'pasted_ocr.json').read_text())
    assert hashlib.sha256((folder / 'pasted_original.png').read_bytes()).hexdigest() == frozen['original_sha256']
    image = tmp_path / 'rectified.png'
    assert rectify(folder / 'pasted_original.png', image)['ok']
    template = export_page_package('b_and_r.injection_holding.multi_stage_position_time', '0.1.1')['template']
    return image, frozen['tokens'], template


def test_actual_pasted_image_restores_three_rejected_contours(pasted):
    image, tokens, template = pasted
    result = extraction.extract_injection_b_and_r(tokens, template, image)
    assert result['fields']['holding_pressure_bar'] == [45., 90.]
    assert result['fields']['holding_time_s'] == [2., 2.]
    assert result['fields']['holding_velocity_pct'] == [5., 10.]
    assert result['fields']['holding_stages'] == 2
    proof = result['detail']['reconstructed_cells']
    assert {(c['row'], c['stage']) for c in proof} == {(1, 1), (2, 1), (2, 2)}
    assert all(min(c['border_support']) >= .85 and c['neighbour_bboxes'] for c in proof)


@pytest.mark.parametrize('damage', ['time_row', 'pressure_row', 'time_bottom_edge', 'stage_header', 'wrong_column'])
def test_insufficient_geometric_evidence_safely_rejects(pasted, tmp_path, monkeypatch, damage):
    image, tokens, template = pasted
    tokens = copy.deepcopy(tokens)
    clean = extraction.extract_injection_b_and_r(tokens, template, image)
    cells = clean['detail']['physical_rows']['holding']
    pixels = cv2.imread(str(image))
    if damage in {'time_row', 'pressure_row'}:
        row = cells[2 if damage == 'time_row' else 1]
        x0, y0 = min(b[0] for b in row), min(b[1] for b in row)
        x1, y1 = max(b[2] for b in row), max(b[3] for b in row)
        pixels[y0-10:y1+10, x0-10:x1+10] = 235
    elif damage == 'time_bottom_edge':
        box = cells[2][0]
        pixels[box[3]-12:box[3]+12, box[0]-5:box[2]+5] = 235
    elif damage == 'stage_header':
        next(t for t in tokens if t['text'] == '2')['text'] = '3'
    else:
        detected = extraction.bordered_cells(cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY))
        target = cells[1][1]
        width = target[2]-target[0]
        shifted = [[b[0]+width//2, b[1], b[2]+width//2, b[3]] if b == target else b for b in detected]
        monkeypatch.setattr(extraction, 'bordered_cells', lambda gray: shifted)
    modified = tmp_path / 'damaged.png'
    cv2.imwrite(str(modified), pixels)
    result = extraction.extract_injection_b_and_r(tokens, template, modified)
    assert result['fields']['holding_pressure_bar'] is None
    assert result['fields']['holding_time_s'] is None
    assert result['fields']['holding_stages'] is None
    assert result['detail']['ocr_rows']['holding']
    assert not any(f['section'] == 'holding' and f['state'] == 'enabled'
                   for f in result['detail']['page_observations']['fields'])


def test_geometry_recovers_without_time_ocr_but_never_fabricates_values(pasted):
    image, tokens, template = pasted
    tokens = [t for t in tokens if t['text'] != '2.00']
    result = extraction.extract_injection_b_and_r(tokens, template, image)
    assert result['fields']['holding_stages'] == 2
    assert result['fields']['holding_pressure_bar'] == [45., 90.]
    assert result['fields']['holding_time_s'] is None
    assert result['detail']['raw_rows']['holding']['time'] == [None, None]


def test_numeric_text_without_borders_cannot_establish_time_row(pasted, tmp_path):
    image, tokens, template = pasted
    clean = extraction.extract_injection_b_and_r(tokens, template, image)
    pixels = cv2.imread(str(image))
    for box in clean['detail']['physical_rows']['holding'][2]:
        x0, y0, x1, y1 = box
        text_only = pixels[y0+15:y1-15, x0+35:x1-35].copy()
        pixels[y0-10:y1+10, x0-10:x1+10] = 235
        pixels[y0+15:y1-15, x0+35:x1-35] = text_only
    target = tmp_path / 'numbers_without_borders.png'
    cv2.imwrite(str(target), pixels)
    result = extraction.extract_injection_b_and_r(tokens, template, target)
    assert result['fields']['holding_time_s'] is None
    assert result['fields']['holding_stages'] is None
