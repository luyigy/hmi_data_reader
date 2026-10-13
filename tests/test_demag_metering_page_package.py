import json
from pathlib import Path

from scripts.export_page_package import export_page_package
from scripts.extract_families.demag import extract_demag
from scripts.extract_families.demag.metering_rows import metering_row_tokens
from scripts.page_template_registry import registered_page_templates
from scripts.extract_fields import norm_tokens
from scripts.extract_families.tact5_process import project_boxes


ROOT = Path(__file__).resolve().parents[1]
PID = 'demag.injection_metering.multi_stage_back_pressure'


def test_metering_rows_follow_confirmed_end_positions_and_exclude_disabled_residue():
    template = export_page_package(PID, '0.2.1')['template']
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
        assert observed['后抽目标位置']['value'] == 45
        assert '后抽距离' not in observed
        assert observed['预塑转速1']['unit'] == rotation_unit
        assert '预塑背压4' not in observed and '预塑原始位置4' not in observed
        assert all(field['state'] == 'unknown' for field in facts['fields'])


def test_metering_unreadable_rotation_unit_stays_unknown():
    fixture = json.loads((ROOT / 'tests/fixtures/demag_metering_z002_ocr.json').read_text())
    template = export_page_package(PID, '0.2.1')['template']
    width, height = fixture['screen_size']
    tokens = [dict(text='螺杆转速' if '螺杆转速[' in line['text'] else line['text'],
                   x=(line['bbox'][0] + line['bbox'][2]) / (2 * width),
                   y=(line['bbox'][1] + line['bbox'][3]) / (2 * height))
              for line in fixture['lines']]
    observed = {field['label']: field for field in
                extract_demag(tokens, template)['detail']['page_observations']['fields']}
    assert observed['预塑转速1']['unit'] is None
    assert 'unit_unobserved' in observed['预塑转速1']['reasons']


def test_metering_duplicate_ocr_cells_keep_four_columns_and_source_boxes(tmp_path):
    fixture = json.loads((ROOT / 'tests/fixtures/demag_metering_z005_ocr.json').read_text())
    width, height = fixture['screen_size']
    lines = [dict(text=line['text'], conf=line.get('confidence', 1.0),
                  bbox=dict(zip(('x_min', 'y_min', 'x_max', 'y_max'), line['bbox'])))
             for line in fixture['lines']]
    duplicates = [{**line, '_src': 'ocr_variant'} for line in lines if line['text'] in
                  ('3.0', '150', '59', '0.00', '10.00', '30.00', '40.00', '45.00', '45.0')]
    tokens = norm_tokens({'lines': lines + duplicates}, fixture['screen_size'])
    template = export_page_package(PID, '0.2.1')['template']
    result = extract_demag(tokens, template)
    fields = result['fields']
    assert [len(fields[key]) for key in ('stage_back_pressure_bar', 'stage_plasticizing_speed_rpm',
                                        'stage_position_mm', 'stage_velocity_mms')] == [4, 4, 6, 2]
    observed = result['detail']['page_observations']['fields']
    assert len(observed) == 11
    project_boxes(observed, dict(screen_size=[width, height], original_size=[width, height],
                                 screen_quad=[[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]))
    assert sum(field['original_bbox'] is not None for field in observed) == 11
    assert all(field['label'] != '后抽距离' for field in observed)

    import cv2
    import numpy as np
    image = np.full((height, width), 200, dtype=np.uint8)
    for key in ('背压', '螺杆转速'):
        row = next(line for line in lines if line['text'].startswith(key) and line['bbox']['x_min'] > width * .2)
        candidates = [line for line in lines if line['text'] in ('0.0', '59') and
                      abs((line['bbox']['y_min'] + line['bbox']['y_max']) / 2 -
                          (row['bbox']['y_min'] + row['bbox']['y_max']) / 2) < height * .02]
        assert len(candidates) == 1
        box = candidates[0]['bbox']
        x, y = int((box['x_min'] + box['x_max']) / 2), int((box['y_min'] + box['y_max']) / 2)
        image[y - int(height * .02):y + int(height * .02), x - 40:x + 40] = 80
    path = tmp_path / 'metering.png'
    assert cv2.imwrite(str(path), image)
    verified = extract_demag(tokens, template, image_path=path)['detail']['page_observations']
    assert verified['stage_counts']['plasticizing']['value'] == 3
    assert all(field['state'] == 'enabled' for field in verified['fields'] if field['stage'])
    assert all(field['state_basis'] == 'grayscale_metering_rows_reference'
               for field in verified['fields'] if field['stage'])
    assert all(field['state'] == 'enabled' and field['state_basis'] == 'grayscale_retract_cells_reference'
               for field in verified['fields'] if field['label'] in ('后抽目标位置', '后抽速度'))

    dark = image.copy()
    rows = metering_row_tokens(tokens)
    for token in (rows['stage_position_mm'][5], rows['stage_velocity_mms'][1]):
        x, y = int(token['x'] * width), int(token['y'] * height)
        dark[y - 30:y + 30, x - 50:x + 50] = 80
    dark_path = tmp_path / 'metering-dark-retract.png'
    assert cv2.imwrite(str(dark_path), dark)
    dark_observed = extract_demag(tokens, template, image_path=dark_path)['detail']['page_observations']['fields']
    assert all(field['state'] == 'unknown' for field in dark_observed
               if field['label'] in ('后抽目标位置', '后抽速度'))
