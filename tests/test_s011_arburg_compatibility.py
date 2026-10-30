"""The unported Arburg page keeps its legacy path; frozen real OCR only."""
import json
from pathlib import Path

import pytest

from extract_fields import extract_one

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('name', ['development', 'retained'])
def test_unported_arburg_real_page_keeps_values_and_identity(name, tmp_path):
    data = ROOT/'datasets/r6_arburg'
    for suffix in ['ocr', 'rectify']:
        (tmp_path/f'{name}.{suffix}.json').write_bytes((data/f'{name}.{suffix}.json').read_bytes())
    result = extract_one(name, tmp_path, None, None, ROOT/'templates')
    baseline = json.loads((ROOT/'tests/fixtures/s011_arburg_baseline.json').read_text())
    assert baseline['baseline_commit'] == '5a0cda3'
    expected = baseline['cases'][name]
    assert result['profile_id'] == expected['profile_id']
    assert result['fields'] == expected['fields']
    assert result['extraction_detail'].get('page_observations') == expected['observations']
    assert result['page_routing']['status'] == ('unsupported' if name == 'retained' else 'unknown')
