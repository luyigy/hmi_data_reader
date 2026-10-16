"""Observable geometry guarantees for every page using the shared projector."""
from copy import deepcopy

import pytest

from extract_families.coordinates import project_boxes


def metadata():
    return dict(screen_size=[101, 101], original_size=[200, 200],
                screen_quad=[[20, 30], [120, 30], [120, 130], [20, 130]])


def observation(box):
    return dict(bbox=box, original_bbox=None, value=25, unit='mm', role='unknown')


def test_projected_box_uses_original_image_percent_and_keeps_facts():
    field = observation([10, 20, 30, 40])
    project_boxes([field], metadata())
    assert field['original_bbox'] == pytest.approx([15, 25, 25, 35])
    assert {key: field[key] for key in ('bbox', 'value', 'unit', 'role')} == {
        'bbox': [10, 20, 30, 40], 'value': 25, 'unit': 'mm', 'role': 'unknown'}


@pytest.mark.parametrize('missing', ['original_size', 'screen_quad'])
def test_missing_transform_keeps_fields_unlocated(missing):
    meta = metadata()
    meta.pop(missing)
    fields = [observation([10, 20, 30, 40])]
    before = deepcopy(fields)
    assert project_boxes(fields, meta) is None
    assert fields == before


@pytest.mark.parametrize('box', [None, [-100, 0, -90, 10], [10, 10, 10, 20]])
def test_absent_outside_or_degenerate_box_does_not_create_evidence(box):
    field = observation(box)
    project_boxes([field], metadata())
    assert field['original_bbox'] is None


def test_perspective_frame_maps_whole_screen_to_quad_bounds():
    meta = metadata()
    meta['screen_quad'] = [[20, 30], [130, 20], [140, 150], [10, 140]]
    field = observation([0, 0, 100, 100])
    project_boxes([field], meta)
    assert field['original_bbox'] == pytest.approx([5, 10, 70, 75])
