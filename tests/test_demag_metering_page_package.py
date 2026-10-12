import json
from pathlib import Path

from scripts.export_page_package import export_page_package
from scripts.extract_families.demag import extract_demag
from scripts.page_template_registry import registered_page_templates


ROOT = Path(__file__).resolve().parents[1]
PID = 'demag.injection_metering.multi_stage_back_pressure'


def test_metering_rows_follow_confirmed_end_positions_and_exclude_disabled_residue():
    template = export_page_package(PID, '0.2.0')['template']
    assert set(template['business_profile_candidate']['field_write_review'].values()) == {'validate_in_main'}
    assert template['business_profile_candidate']['pressure_basis'] == 'hydraulic_pressure'
    assert export_page_package(PID, '0.1.0')['template']['business_profile_candidate']['pressure_basis'] is None
    for machine, speeds, ends, rotation_unit in (
            ('z002', [150, 150, 150, 45], [25, 35, 40], 'rpm'),
            ('z005', [150, 150, 150, 59], [10, 30, 40], 'mm/s')):
        fixture = json.loads((ROOT / f'tests/fixtures/demag_metering_{machine}_ocr.json').read_text())
        matches = registered_page_templates('DEMAG', ROOT / 'templates', page='injection_metering', lines=fixture['lines'])
        assert [item['profile_id'] for item in matches] == [PID]
        width, height = fixture['screen_size']
        tokens = [dict(text=line['text'], x=(line['bbox'][0] + line['bbox'][2]) / (2 * width),
                       y=(line['bbox'][1] + line['bbox'][3]) / (2 * height)) for line in fixture['lines']]
        result = extract_demag(tokens, template)
        assert result['detail']['page_variant'] == 'multi_stage_back_pressure'
        assert result['fields']['stage_back_pressure_bar'] == [3, 3, 3, 0]
        assert result['fields']['stage_plasticizing_speed_rpm'] == speeds
        facts = result['detail']['page_observations']
        assert facts['profile_id'] == PID
        observed = {field['label']: field for field in facts['fields']}
        assert [observed[f'预塑终点{n}']['value'] for n in (1, 2)] == ends[:2]
        assert observed['熔料结束位置']['value'] == ends[2]
        assert observed['后抽距离']['value'] == 5
        assert observed['预塑转速1']['unit'] == rotation_unit
        assert '预塑背压4' not in observed and '预塑原始位置4' not in observed
        assert all(field['state'] == 'unknown' for field in facts['fields'])


def test_metering_unreadable_rotation_unit_stays_unknown():
    fixture = json.loads((ROOT / 'tests/fixtures/demag_metering_z002_ocr.json').read_text())
    template = export_page_package(PID, '0.2.0')['template']
    width, height = fixture['screen_size']
    tokens = [dict(text='螺杆转速' if '螺杆转速[' in line['text'] else line['text'],
                   x=(line['bbox'][0] + line['bbox'][2]) / (2 * width),
                   y=(line['bbox'][1] + line['bbox'][3]) / (2 * height))
              for line in fixture['lines']]
    observed = {field['label']: field for field in
                extract_demag(tokens, template)['detail']['page_observations']['fields']}
    assert observed['预塑转速1']['unit'] is None
    assert 'unit_unobserved' in observed['预塑转速1']['reasons']
