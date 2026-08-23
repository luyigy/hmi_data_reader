import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import vlm_qwen  # noqa: E402
import vlm_text_eval  # noqa: E402


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
            "t4": {"text": "180J", "conf": 0.95, "bbox": [0.3, 0.5, 0.4, 0.6]},
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
        {"field": "holding_time_s", "value_token_ids": ["t4"]},
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


def test_partial_mapping_keeps_valid_sibling():
    result = vlm_qwen.validate_text_mappings_partial({"mappings": [
        {"field": "holding_time_s", "value_token_ids": ["t1"]},
        {"field": "stage_velocity_mms", "value_token_ids": ["missing"],
         "active_count": 1},
    ]}, _evidence(), vlm_qwen.fields_for_page(CATALOG, "injection_metering"))

    assert result["fields"] == {"holding_time_s": 2.5}
    assert result["unresolved"][0]["field"] == "stage_velocity_mms"


def test_image_output_rejects_empty_content():
    with pytest.raises(vlm_qwen.VlmError, match="响应内容为空"):
        vlm_qwen._parse_output({"choices": [{"message": {"content": None}}]})


def test_text_request_contains_only_page_evidence_and_catalog_subset():
    prompt = vlm_qwen.build_text_prompt(
        _evidence(), vlm_qwen.fields_for_page(CATALOG, "injection_metering"))
    request = json.loads(prompt.split("输入：", 1)[1])

    assert set(request) == {"evidence", "catalog_fields"}
    assert set(request["catalog_fields"]) == {"holding_time_s", "stage_velocity_mms"}
    assert set(request["evidence"]) == {"page_type", "tokens", "rows", "supplements"}
    assert "image" not in prompt and "cooling_time_s" not in prompt
    assert request["catalog_fields"]["holding_time_s"]["role"] is None


def test_unresolved_request_excludes_resolved_fields_and_tokens():
    generic = {
        "fields": {"holding_time_s": 2.5},
        "detail": {
            "evidence": _evidence(),
            "mappings": [{"field": "holding_time_s", "label_token_ids": ["t0"],
                          "value_token_ids": ["t1"]}],
            "unresolved": [{"field": "stage_velocity_mms", "reason": "AMBIGUOUS",
                            "label_token_ids": [], "value_token_ids": ["t2"]}],
        },
    }

    evidence, fields = vlm_text_eval._unresolved_request(generic, CATALOG)

    assert fields == {"stage_velocity_mms"}
    assert set(evidence["tokens"]) == {"t2"}
    assert "t0" not in evidence["tokens"] and "holding_time_s" not in fields

    merged, added = vlm_text_eval._merge_fields(
        {"holding_time_s": 2.5}, {"holding_time_s": 99, "stage_velocity_mms": [10]})
    assert merged == {"holding_time_s": 2.5, "stage_velocity_mms": [10]}
    assert added == {"stage_velocity_mms": [10]}
    assert vlm_text_eval._hybrid_status(merged, set(), True) == "review"
    assert vlm_text_eval._hybrid_status({}, fields, False) == "reject"


def test_catalog_labels_add_only_structurally_matching_unresolved_fields():
    catalog = {"fields": {
        "stage_holding_pressure_bar": {
            "label_zh": "各段保压压力", "value_type": "list[float]", "unit": "bar",
            "source_pages": ["injection_metering"],
        },
        "holding_pressure_bar": {
            "label_zh": "保压压力", "value_type": "float", "unit": "bar",
            "source_pages": ["injection_metering"],
        },
        "holding_pressure_mpa": {
            "label_zh": "各段保压压力", "value_type": "list[float]", "unit": "MPa",
            "source_pages": ["injection_metering"],
        },
        "holding_velocity_pct": {
            "label_zh": "各段保压速度", "value_type": "list[float]", "unit": "%",
            "source_pages": ["injection_metering"],
        },
    }}
    generic = {"fields": None, "detail": {"mappings": [], "unresolved": [],
        "evidence": {"page_type": "injection_metering", "tokens": {
            "title": {"text": "多级保压"}, "label": {"text": "压力[bar]"},
            "p0": {"text": "0.0"}, "p1": {"text": "52.9"}, "p2": {"text": "39.7"},
            "speed": {"text": "速度[mm/s]"}, "v0": {"text": "15.0"},
            "v1": {"text": "10.0"},
        }, "rows": [
            {"text": "多级保压", "label_token_ids": ["title"], "value_token_ids": []},
            {"text": "压力[bar] 0.0 52.9 39.7", "label_token_ids": [],
             "value_token_ids": ["p0", "p1", "p2"]},
            {"text": "速度[mm/s] 15.0 10.0", "label_token_ids": [],
             "value_token_ids": ["v0", "v1"]},
        ]}}}

    evidence, fields = vlm_text_eval._unresolved_request(generic, catalog)

    assert fields == {"stage_holding_pressure_bar"}
    assert set(evidence["tokens"]) == {"title", "label", "p0", "p1", "p2"}


def test_text_eval_merges_existing_ocr_supplements(tmp_path):
    base = tmp_path / "case.ocr.json"
    base.write_text(json.dumps({"lines": [{
        "text": "速率%", "conf": 0.99,
        "bbox": {"x_min": 0, "y_min": 0, "x_max": 10, "y_max": 10},
    }]}), encoding="utf-8")
    (tmp_path / "case.ocr_rates.json").write_text(json.dumps({"lines": [{
        "text": "25", "conf": 0.98,
        "bbox": {"x_min": 20, "y_min": 0, "x_max": 30, "y_max": 10},
    }]}), encoding="utf-8")

    assert [line["text"] for line in vlm_text_eval._text_eval_ocr(base, [100, 100])["lines"]] == ["速率%", "25"]


def test_text_eval_selects_latest_duplicate_sidecar(tmp_path):
    old = tmp_path / "old" / "case.ocr.json"
    new = tmp_path / "new" / "case.ocr.json"
    old.parent.mkdir()
    new.parent.mkdir()
    old.write_text("{}", encoding="utf-8")
    new.write_text("{}", encoding="utf-8")
    os.utime(old, ns=(1, 1))
    os.utime(new, ns=(2, 2))

    assert vlm_text_eval._text_eval_sidecars(tmp_path, {"case"})["case"] == new


def test_multi_holding_order_and_disabled_slots_are_deterministic():
    evidence = {
        "page_type": "injection_metering",
        "tokens": {
            "title": {"text": "多级保压"},
            "p0": {"text": "0.0"}, "p1": {"text": "55.0"},
            "p2": {"text": "60.0"}, "p3": {"text": "65.0"},
            "t0": {"text": "0.000"}, "t1": {"text": "1.000"},
            "t2": {"text": "2.000"},
        },
        "rows": [
            {"text": "多级保压", "value_token_ids": []},
            {"text": "压力[bar] 0.0 55.0 60.0 65.0",
             "value_token_ids": ["p0", "p1", "p2", "p3"]},
            {"text": "时间[s] 0.000 1.000 2.000",
             "value_token_ids": ["t0", "t1", "t2"]},
        ],
    }
    page_fields = {
        "stage_holding_pressure_bar": {"value_type": "list[float]"},
        "stage_holding_time_s": {"value_type": "list[float]"},
    }
    output = {"mappings": [
        {"field": "stage_holding_pressure_bar",
         "value_token_ids": ["p0", "p1", "p2", "p3"],
         "screen_order": "screen_left_to_right", "active_count": 4},
        {"field": "stage_holding_time_s", "value_token_ids": ["t0", "t1", "t2"],
         "screen_order": "screen_left_to_right", "active_count": 3},
    ]}

    result = vlm_qwen.validate_text_mappings(output, evidence, page_fields)

    assert result["fields"] == {
        "stage_holding_pressure_bar": [65.0, 60.0, 55.0],
        "stage_holding_time_s": [2.0, 1.0],
    }


def test_multi_holding_rejects_unit_only_rows():
    evidence = {
        "page_type": "injection_metering",
        "tokens": {"title": {"text": "多级保压"}, "p0": {"text": "39.7"}},
        "rows": [{"text": "多级保压", "value_token_ids": []},
                 {"text": "[bar] 39.7", "value_token_ids": ["p0"]}],
    }
    with pytest.raises(vlm_qwen.VlmError, match="业务行锚点缺失"):
        vlm_qwen.validate_text_mappings(
            {"mappings": [{"field": "stage_holding_pressure_bar",
                            "value_token_ids": ["p0"], "active_count": 1}]},
            evidence, {"stage_holding_pressure_bar": {"value_type": "list[float]"}})


def test_rate_cell_supplement_overrides_full_ocr_misread():
    evidence = {
        "page_type": "temperature",
        "tokens": {
            "bad0": {"text": "0"}, "bad1": {"text": "0"},
            "r0": {"text": "25"}, "r1": {"text": "15"},
            "r2": {"text": "3"}, "r3": {"text": "41"}, "r4": {"text": "-8"},
        },
        "rows": [],
        "supplements": {"rate_cell": ["r0", "r1", "r2", "r3", "r4"]},
    }
    output = {"mappings": [
        {"field": "control_percent", "value_token_ids": ["bad0", "bad1"],
         "active_count": 2},
    ]}
    page_fields = {"control_percent": {"value_type": "list[float]"},
                   "drop_port_control_percent": {"value_type": "float"}}

    result = vlm_qwen.validate_text_mappings(output, evidence, page_fields)

    assert result["fields"] == {"control_percent": [25.0, 15.0, 3.0, 41.0],
                                "drop_port_control_percent": -8.0}
