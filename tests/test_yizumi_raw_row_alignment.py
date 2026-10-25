import copy
import json
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from raw_yizumi import observe_yizumi_page


def original(sample):
    path = ROOT / f'tests/fixtures/yizumi_row_{sample}_live.json'
    raw = json.loads(path.read_text())['observations']
    import hashlib
    assert hashlib.sha256((ROOT / f'datasets/r6_yizumi/{sample}.jpg').read_bytes()).hexdigest() == raw['image_sha256']
    return raw


def observe(raw, lines=None):
    return observe_yizumi_page(lines or raw['ocr_evidence']['lines'], raw['transform'], raw['image_sha256'])


@pytest.mark.parametrize('sample,expected', [('development', [15, 1, 3]), ('retained', [10, 3, 0])])
def test_visible_time_values_and_existing_known_readings(sample, expected):
    raw = original(sample)
    observed = observe(raw)
    fields = {row['screen_field_key']: row for row in observed['fields']}
    keys = ['left.cooling.setting', 'holding.time.stage-1', 'holding.time.stage-2']
    assert [fields[key]['value'] for key in keys] == expected
    assert all(fields[key]['reading'] == 'known' and fields[key]['unit'] == 's' for key in keys)
    for old in raw['fields']:
        if old['reading'] == 'known':
            assert fields[old['screen_field_key']]['value'] == old['value']


def test_two_overlapping_values_remain_conflict():
    raw = original('retained')
    lines = copy.deepcopy(raw['ocr_evidence']['lines'])
    duplicate = copy.deepcopy(lines[90])
    duplicate['text'] = '4.00'
    lines.append(duplicate)
    field = next(row for row in observe(raw, lines)['fields'] if row['screen_field_key'] == 'holding.time.stage-1')
    assert field['reading'] == 'conflict' and field['value'] is None
    assert len(field['candidates']) == 2


def test_value_below_row_is_not_associated():
    raw = original('retained')
    lines = copy.deepcopy(raw['ocr_evidence']['lines'])
    box = lines[90]['bbox']
    box[1] += 60
    box[3] += 60
    field = next(row for row in observe(raw, lines)['fields'] if row['screen_field_key'] == 'holding.time.stage-1')
    assert field['reading'] == 'missing' and field['value'] is None


def test_missing_time_with_shifted_sibling_does_not_import_speed():
    raw = original('retained')
    lines = copy.deepcopy(raw['ocr_evidence']['lines'])
    lines[90]['text'] = '?'
    scale_y = raw['layout_alignment']['scale'][1]
    offset_y = raw['layout_alignment']['offset'][1]
    center_y = (.772 * scale_y + offset_y) * raw['ocr_evidence']['screen_size'][1]
    box = lines[89]['bbox']
    height = box[3] - box[1]
    box[1], box[3] = center_y - height / 2, center_y + height / 2
    field = next(row for row in observe(raw, lines)['fields'] if row['screen_field_key'] == 'holding.time.stage-1')
    assert field['reading'] == 'missing' and field['value'] is None


def test_shared_row_boundary_cannot_create_two_known_fields():
    raw = original('retained')
    lines = copy.deepcopy(raw['ocr_evidence']['lines'])
    lines[86]['text'] = '?'
    lines[90]['text'] = '?'
    y = (.7675 * raw['layout_alignment']['scale'][1] + raw['layout_alignment']['offset'][1]) * raw['ocr_evidence']['screen_size'][1]
    lines.append(dict(text='7', confidence=.99, bbox=[1400, y-10, 1430, y+10]))
    fields = {row['screen_field_key']: row for row in observe(raw, lines)['fields']}
    for key in ('holding.speed.stage-1', 'holding.time.stage-1'):
        assert fields[key]['reading'] == 'missing' and fields[key]['value'] is None


def test_repaired_package_is_exportable_by_bound_version():
    from export_page_package import export_page_package
    package = export_page_package("yizumi.injection_metering.injection_holding_f2", "1.0.1", ROOT)
    assert package["version"] == "1.0.1"
    assert package["template"]["version"] == "1.0.1"
    assert package["recognizer"]["version"] == "1.0.1"


def test_historical_package_remains_exportable_after_recognizer_upgrade():
    from export_page_package import export_page_package
    from raw_contract import import_raw_package
    package = export_page_package("yizumi.injection_metering.injection_holding_f2", "1.0.0", ROOT)
    import_raw_package(package)
    assert package["version"] == "1.0.0"
    assert package["recognizer"]["version"] == "1.0.0"
    upgraded = export_page_package("yizumi.injection_metering.injection_holding_f2", "1.0.1", ROOT)
    assert upgraded["recognizer"]["sha256"] != package["recognizer"]["sha256"]
