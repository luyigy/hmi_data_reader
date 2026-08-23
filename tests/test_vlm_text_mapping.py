import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import vlm_qwen  # noqa: E402


CATALOG = {"fields": {
    "holding_time_s": {"source_pages": ["injection_metering"], "value_type": "float",
                       "label_zh": "保压时间", "unit": "s", "entity": {}},
    "stage_velocity_mms": {"source_pages": ["injection_metering"],
                           "value_type": "list[float]", "label_zh": "各段射胶速度",
                           "unit": "mm/s", "entity": {"order": "physical_stage"}},
    "cooling_time_s": {"source_pages": ["cooling_ejection"], "value_type": "float",
                       "label_zh": "冷却时间", "unit": "s", "entity": {}},
}}


def _evidence():
    return {
        "page_type": "injection_metering",
        "tokens": {
            "t0": {"text": "保压时间", "conf": 0.98, "bbox": [0, 0, 0.2, 0.1]},
            "t1": {"text": "2.5", "conf": 0.97, "bbox": [0.3, 0, 0.4, 0.1]},
            "t2": {"text": "0 0 30 20 10", "conf": 0.96, "bbox": [0.3, 0.2, 0.8, 0.3]},
            "t3": {"text": "3O", "conf": 0.55, "bbox": [0.3, 0.4, 0.4, 0.5]},
        },
        "rows": [{"label_token_ids": ["t0"], "value_token_ids": ["t1"],
                  "text": "保压时间 2.5", "order": "screen_left_to_right"}],
        "ignored": {"image": "must-not-leak.jpg", "other_page": 42},
    }


def test_text_mapping_scalar_array_reverse_and_disabled():
    output = {"mappings": [
        {"field": "holding_time_s", "value_token_ids": ["t1"],
         "screen_order": "screen_left_to_right", "active_count": 1},
        {"field": "stage_velocity_mms", "value_token_ids": ["t2"],
         "screen_order": "reverse_physical", "active_count": 3},
    ], "unresolved": [], "notes": []}

    result = vlm_qwen.validate_text_mappings(
        output, _evidence(), vlm_qwen.fields_for_page(CATALOG, "injection_metering"))

    assert result["fields"] == {"holding_time_s": 2.5,
                                "stage_velocity_mms": [10.0, 20.0, 30.0]}


def test_text_mapping_rejects_invalid_outputs():
    page_fields = vlm_qwen.fields_for_page(CATALOG, "injection_metering")
    bad_mappings = [
        {"field": "unknown", "value_token_ids": ["t1"]},
        {"field": "holding_time_s", "value_token_ids": ["missing"]},
        {"field": "holding_time_s", "value_token_ids": ["t1"], "value": 2.5},
        {"field": "holding_time_s", "value_token_ids": ["t1"], "active_count": True},
        {"field": "stage_velocity_mms", "value_token_ids": ["t2"], "active_count": 6},
        {"field": "holding_time_s", "value_token_ids": ["t3"]},
    ]
    for mapping in bad_mappings:
        with pytest.raises(vlm_qwen.VlmError):
            vlm_qwen.validate_text_mappings(
                {"mappings": [mapping]}, _evidence(), page_fields)

    with pytest.raises(vlm_qwen.VlmError):
        vlm_qwen.validate_text_mappings(
            {"mappings": [
                {"field": "holding_time_s", "value_token_ids": ["t1"]},
                {"field": "stage_velocity_mms", "value_token_ids": ["t1"], "active_count": 1},
            ]}, _evidence(), page_fields)
    with pytest.raises(vlm_qwen.VlmError):
        vlm_qwen.validate_text_mappings(
            {"mappings": [
                {"field": "holding_time_s", "value_token_ids": ["t1"]},
                {"field": "holding_time_s", "value_token_ids": ["t3"]},
            ]}, _evidence(), page_fields)
    with pytest.raises(vlm_qwen.VlmError):
        vlm_qwen._parse_mapping_output(
            {"choices": [{"message": {"content": "not-json"}}]})
    with pytest.raises(vlm_qwen.VlmError):
        vlm_qwen._parse_mapping_output({"choices": [{"message": {"content":
            '{"mappings":[],"notes":[123],"unresolved":[]}'}}]})


def test_text_request_contains_only_page_evidence_and_catalog_subset():
    prompt = vlm_qwen.build_text_prompt(
        _evidence(), vlm_qwen.fields_for_page(CATALOG, "injection_metering"))
    request = json.loads(prompt.split("输入：", 1)[1])

    assert set(request) == {"evidence", "catalog_fields"}
    assert set(request["catalog_fields"]) == {"holding_time_s", "stage_velocity_mms"}
    assert set(request["evidence"]) == {"page_type", "tokens", "rows"}
    assert "image" not in prompt and "cooling_time_s" not in prompt
