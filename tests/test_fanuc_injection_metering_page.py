import json
import sys
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
