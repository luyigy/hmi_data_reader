import json
from pathlib import Path

from scripts.export_page_package import export_page_package
from scripts.extract_families.demag import extract_demag
from scripts.page_template_registry import registered_page_templates


ROOT = Path(__file__).resolve().parents[1]
PID = 'demag.injection_metering.multi_stage_back_pressure'


def test_metering_rows_survive_two_distinct_photo_slopes_without_write_approval():
    template = export_page_package(PID, '0.1.0')['template']
    assert set(template['business_profile_candidate']['field_write_review'].values()) == {'observation_only'}
    for machine, speeds in (('z002', [150, 150, 150, 45]), ('z005', [150, 150, 150, 59])):
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
        assert result['detail']['page_observations']['profile_id'] == PID
        assert all(field['state'] == 'unknown' for field in result['detail']['page_observations']['fields'])
