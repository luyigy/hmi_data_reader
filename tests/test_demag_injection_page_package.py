import json
from pathlib import Path

from scripts.export_page_package import export_page_package
from scripts.extract_families.demag.observations import injection_observations
from scripts.extract_families.demag import extract_demag
from scripts.page_template_registry import registered_page_templates


ROOT = Path(__file__).resolve().parents[1]
PID = 'demag.injection_metering.multi_stage_injection'


def test_injection_page_routes_and_exports_reviewed_sample():
    fixture = json.loads((ROOT / 'tests/fixtures/demag_injection_z002_wehdt_ocr.json').read_text())
    matches = registered_page_templates('DEMAG', ROOT / 'templates', page='injection_metering', lines=fixture['lines'])
    assert [item['profile_id'] for item in matches] == [PID]
    package = export_page_package(PID, '0.1.0')
    assert package['samples'][0]['manifest']['sample_id'] == 'Z002_WeHdT'
    assert package['template']['business_profile_candidate']['injection_position_meaning'] == 'stage_start_position'
    width, height = fixture['screen_size']
    tokens = [dict(text=line['text'], x=(line['bbox'][0] + line['bbox'][2]) / (2 * width),
                   y=(line['bbox'][1] + line['bbox'][3]) / (2 * height)) for line in fixture['lines']]
    result = extract_demag(tokens, package['template'])
    assert result['detail']['page_observations']['profile_id'] == PID
    assert result['fields']['stage_velocity_mms'][:2] == [75, 25]
    assert result['fields']['stage_position_mm'][:2] == [45, 22.5]


def test_injection_observations_keep_physical_order_and_unknown_stage_state():
    facts = injection_observations(dict(stage_velocity_mms=[75, 25], stage_position_mm=[45, 22.5],
        injection_pressure_limit_bar=100, switch_position_mm=17.5,
        holding_pressure_bar=60, holding_velocity_mms=12))
    assert facts['profile_id'] == PID
    assert [(f['label'], f['value'], f['state']) for f in facts['fields'][:4]] == [
        ('射胶速度1', 75, 'unknown'), ('射胶速度2', 25, 'unknown'),
        ('射胶起点1', 45, 'unknown'), ('射胶起点2', 22.5, 'unknown')]
    assert all(f['original_bbox'] is None for f in facts['fields'])
