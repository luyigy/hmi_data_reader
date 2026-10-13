import json
import sys
from hashlib import sha256
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from export_page_package import export_page_package
from extract_families.fanuc_injection import extract_injection_fanuc
from page_template_registry import registered_page_templates

ROOT = Path(__file__).resolve().parents[1]
PID = 'fanuc.injection_metering.injection_holding_metering'
FIXTURE = 'tests/fixtures/fanuc_injection_metering_z036_rank04_ocr.json'
TRUTH = 'ground_truth/mc_z036_injection/inj_Z036_20250511_rank04_recuQJJFYYxREp.truth.json'


def _tokens(fixture: dict) -> list[dict]:
    width, height = fixture['screen_size']
    return [dict(text=line['text'], x=(line['bbox'][0] + line['bbox'][2]) / (2 * width),
                 y=(line['bbox'][1] + line['bbox'][3]) / (2 * height)) for line in fixture['lines']]


def test_fanuc_page_routes_and_exports_reviewed_sample():
    fixture = json.loads((ROOT / FIXTURE).read_text())
    matches = registered_page_templates('FANUC', ROOT / 'templates', page='injection_metering',
                                        lines=fixture['lines'])
    assert [item['profile_id'] for item in matches] == [PID]
    package = export_page_package(PID, '0.1.0')
    assert package['package_schema'] == 'hmi_page_package.v1'
    assert package['samples'][0]['manifest']['sample_id'] == 'Z036_rank04'
    candidate = package['template']['business_profile_candidate']
    assert candidate['page_kind'] == 'process_settings'
    assert candidate['pressure_basis'] == 'plastic_pressure'


def test_fanuc_extraction_matches_truth_metering_subset():
    fixture = json.loads((ROOT / FIXTURE).read_text())
    package = export_page_package(PID, '0.1.0')
    result = extract_injection_fanuc(_tokens(fixture), package['template'])
    assert result['warnings'] == []
    truth = json.loads((ROOT / TRUTH).read_text())
    assert truth['controller_family'] == 'FANUC' and truth['page_type'] == 'injection_metering'
    # 真值只覆盖储料/冷却子集；未入真值的射出/保压侧字段不据此断言。
    for key, expected in truth['fields'].items():
        assert result['fields'][key] == expected, key
    # 射出侧仅固定当前提取观测：屏幕列序 [2段,1段] 已逆序为物理段序。
    assert result['fields']['injection_velocity_mms'] == [220.0, 185.0]
    assert result['fields']['holding_pressure_mpa'] == [35.0, 5.0]


def test_fanuc_full_page_visual_review_matches_original_and_extraction():
    review = json.loads((ROOT / 'ground_truth/mc_z036_injection/Z036_rank04_full_page_visual_review.json').read_text())
    assert sha256((ROOT / review['image']).read_bytes()).hexdigest() == review['image_sha256']
    assert review['human_adjudication'].startswith('injection_holding_13_confirmed_by_owner')
    assert len(review['fields']) == 27
    fixture = json.loads((ROOT / FIXTURE).read_text())
    package = export_page_package(PID, '0.1.1')
    result = extract_injection_fanuc(_tokens(fixture), package['template'])['fields']
    expected = {
        'injection.speed': ('injection_velocity_mms', 2),
        'injection.pressure': ('injection_pressure_limit_mpa', 2),
        'holding.pressure': ('holding_pressure_mpa', 2),
        'holding.time': ('holding_time_s', 2),
    }
    for prefix, (key, count) in expected.items():
        assert result[key] == [review['fields'][f'{prefix}.{n}']['value'] for n in range(1, count + 1)]
    scalar = {'injection.end.1': 'injection_switch_position_mm',
              'vp.position': 'vp_switch_position_mm',
              'holding.speed.shared': 'holding_limit_speed_mms',
              'injection.time.limit': 'max_injection_time_s',
              'injection.alarm.pressure': 'injection_alarm_pressure_mpa'}
    for field_id, key in scalar.items():
        assert result[key] == review['fields'][field_id]['value']
    metering = {'plasticizing.pressure': 'metering_back_pressure_mpa',
                'plasticizing.speed': 'metering_rpm_stages',
                'plasticizing.end': 'metering_switch_positions_mm'}
    for prefix, key in metering.items():
        assert result[key] == [review['fields'][f'{prefix}.{n}']['value']
                               for n in range(1, len(result[key]) + 1)]
    for field_id, key in {'plasticizing.manual_back_pressure': 'back_pressure_mpa',
                          'plasticizing.manual_rpm': 'metering_rpm',
                          'metering.end': 'metering_position_mm',
                          'retract.post.distance': 'decompress_position_mm',
                          'retract.post.speed': 'decompress_mms',
                          'cooling.time': 'cooling_time_s'}.items():
        assert result[key] == review['fields'][field_id]['value']


def test_fanuc_full_page_values_reach_capture_review_contract():
    fixture = json.loads((ROOT / FIXTURE).read_text())
    package = export_page_package(PID, '0.1.1')
    result = extract_injection_fanuc(_tokens(fixture), package['template'])
    observations = result['detail']['page_observations']
    review = json.loads((ROOT / 'ground_truth/mc_z036_injection/Z036_rank04_full_page_visual_review.json').read_text())
    by_label = {row['label']: row for row in observations['fields']}
    aliases = package['template']['business_profile_candidate']['possible_names']
    assert len(by_label) == len(review['fields']) == 27
    for field_id, expected in review['fields'].items():
        alias_id = '.'.join([*field_id.split('.')[:-1], '{n}']) if field_id.split('.')[-1].isdigit() else field_id
        label = aliases[alias_id][0].replace('{n}', field_id.split('.')[-1])
        assert by_label[label]['value'] == expected['value']
        assert by_label[label]['unit'] == expected['unit']
        assert 'source_box_unavailable' in by_label[label]['reasons']
