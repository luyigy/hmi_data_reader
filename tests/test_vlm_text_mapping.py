import io
import json
import os
import sys
from pathlib import Path

import pytest
from PIL import Image

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


def _draft_item(value, label=None, source="ocr", evidence="屏幕证据"):
    return {"label": label, "value": value, "sources": [source],
            "evidence": [evidence], "needs_confirmation": True}


def _draft_field(label, role, unit, items, canonical_id=None):
    return {"screen_label": label, "canonical_id": canonical_id, "role": role,
            "unit": unit, "items": items,
            "sources": list(dict.fromkeys(source for item in items
                                           for source in item["sources"])),
            "evidence": list(dict.fromkeys(note for item in items
                                            for note in item["evidence"])),
            "needs_confirmation": True}


def _draft_response(payload):
    return {"choices": [{"message": {"content": json.dumps(
        payload, ensure_ascii=False)}}]}


def test_draft_candidates_are_whitelisted_and_accept_user_correction(monkeypatch):
    captured = {}

    def completion(prompt, _base_url, _model):
        captured["request"] = json.loads(prompt.split("输入：", 1)[1])
        return _draft_response({"sections": [{"label": "保压", "fields": [
            _draft_field("保压时间", "setpoint", "s", [
                _draft_item(3.0, evidence="用户纠正：保压时间=3.0")]),
            _draft_field("周期时间", "actual", "s", [
                _draft_item(12.4, evidence="周期时间 12.4 s")]),
        ]}], "questions": []})

    monkeypatch.setattr(vlm_qwen, "_text_completion", completion)
    result = vlm_qwen.draft_from_ocr({"lines": [
        {"text": "保压时间 2.5 s", "confidence": 0.9, "bbox": [1, 2, 3, 4]},
        {"text": "保压压力 360 320 bar", "confidence": 0.9, "bbox": [1, 5, 3, 6]},
    ], "page_type": "wrong-page"}, "保压时间=3.0", "normal_trial.holding",
        {"holding_segments": 3}, [
            {"field_id": "holding_time", "label": "保压时间", "unit": "s",
             "shape": "scalar", "role": "setpoint"},
        ])

    fields = result["sections"][0]["fields"]
    assert fields[0]["canonical_id"] == "holding_time"
    assert fields[0]["items"][0]["value"] == 3.0
    assert fields[1]["screen_label"] == "周期时间"
    assert fields[1]["canonical_id"] is None
    assert captured["request"]["user_message"] == "保压时间=3.0"
    assert "canonical_hints" in captured["request"]


def test_draft_candidates_reject_invalid_vlm_output(monkeypatch):
    allowed = [{"field_id": "holding_time", "label": "保压时间", "unit": "s",
                "shape": "scalar", "role": "setpoint"}]
    valid = {"sections": [{"label": "保压", "fields": [
        _draft_field("保压时间", "setpoint", "s", [_draft_item(2.5)])
    ]}], "questions": []}
    invalid = [
        "not-json",
        json.dumps({**valid, "extra": True}),
        json.dumps({"sections": [{"label": "保压", "fields": [
            _draft_field("保压时间", "mystery", "s", [_draft_item(2.5)])
        ]}], "questions": []}),
        json.dumps({"sections": [{"label": "保压", "fields": [
            _draft_field("保压时间", "setpoint", "s", [
                _draft_item(True, evidence="bad")])
        ]}], "questions": []}),
    ]

    for content in invalid:
        monkeypatch.setattr(vlm_qwen, "_text_completion", lambda *_args, value=content: {
            "choices": [{"message": {"content": value}}]})
        with pytest.raises(vlm_qwen.VlmError):
            vlm_qwen.draft_from_ocr(
                {"lines": [{"text": "保压时间 2.5 s"}]}, "", "normal_trial.holding",
                {"holding_segments": 1}, allowed)


def test_draft_from_empty_ocr_requests_reshoot(monkeypatch):
    monkeypatch.setattr(vlm_qwen, "_text_completion",
                        lambda *_args: pytest.fail("empty OCR must not call VLM"))

    result = vlm_qwen.draft_from_ocr(
        {}, "", "normal_trial.holding", {"holding_segments": 1}, [])

    assert result == {"sections": [], "questions": ["没有图片或 OCR 文字可供识别。"]}


def test_draft_uses_image_when_ocr_is_empty(monkeypatch):
    image = io.BytesIO()
    Image.new("RGB", (2, 2), "white").save(image, "PNG")
    captured = {}

    def completion(image_b64, prompt, base_url, model):
        captured.update(image_b64=image_b64, prompt=prompt,
                        base_url=base_url, model=model)
        return _draft_response({"sections": [{"label": "保压", "fields": [
            _draft_field("保压时间", "setpoint", "s", [
                _draft_item(2.5, source="vlm", evidence="屏幕保压时间")])
        ]}], "questions": []})

    monkeypatch.setattr(vlm_qwen, "_chat_completion", completion)
    monkeypatch.setenv("HMI_DRAFT_VLM_MODEL", "Qwen3.8-27B-AWQ-INT4")
    result = vlm_qwen.draft_from_ocr(
        {}, "", "normal_trial.holding", {},
        [{"field_id": "holding_time", "label": "保压时间", "unit": "s",
          "shape": "scalar", "role": "setpoint"}], image.getvalue())

    assert result["sections"][0]["fields"][0]["items"][0]["value"] == 2.5
    assert result["questions"] == []
    assert captured["image_b64"]
    assert captured["model"] == "Qwen3.8-27B-AWQ-INT4"
    assert "canonical_hints 仅供匹配，不是输出白名单" in captured["prompt"]


def test_draft_keeps_generic_sections_roles_and_item_labels(monkeypatch):
    sections = [
        {"label": "温度", "fields": [
            _draft_field("料管温度", role, "°C", [
                _draft_item(value, zone, "vlm", f"{role}-{zone}")
                for zone, value in [("喷嘴", 230 if role == "setpoint" else 228),
                                    ("前部", 225 if role == "setpoint" else 224)]])
            for role in ("setpoint", "actual")]},
        {"label": "射胶/保压", "fields": [
            _draft_field("射胶速度", role, "mm/s", [
                _draft_item(value, stage, "vlm", f"{role}-{stage}")
                for stage, value in [("1段", 80 if role == "setpoint" else 78),
                                     ("2段", 60 if role == "setpoint" else 59)]])
            for role in ("setpoint", "actual")]},
        {"label": "熔胶", "fields": [
            _draft_field("熔胶转速", role, "rpm", [
                _draft_item(100 if role == "setpoint" else 97, "1段", "vlm", role)])
            for role in ("setpoint", "actual")]},
        {"label": "冷却", "fields": [
            _draft_field("冷却时间", "setpoint", "s", [_draft_item(8, source="vlm")])]},
    ]
    monkeypatch.setattr(vlm_qwen, "_text_completion",
                        lambda *_: _draft_response({"sections": sections, "questions": []}))
    result = vlm_qwen.draft_from_ocr(
        {"lines": [{"text": "HMI 参数"}]}, "", "trial", {}, [
            {"field_id": "barrel_set", "label": "料管温度", "unit": "°C",
             "shape": "array", "role": "setpoint"},
            {"field_id": "barrel_actual", "label": "料管温度", "unit": "°C",
             "shape": "array", "role": "actual"},
        ])

    assert [section["label"] for section in result["sections"]] == [
        "温度", "射胶/保压", "熔胶", "冷却"]
    assert [field["canonical_id"] for field in result["sections"][0]["fields"]] == [
        "barrel_set", "barrel_actual"]
    assert [item["label"] for item in result["sections"][1]["fields"][0]["items"]] == [
        "1段", "2段"]
    assert result["sections"][1]["fields"][1]["canonical_id"] is None
    assert {field["role"] for field in result["sections"][2]["fields"]} == {
        "setpoint", "actual"}
    assert [field["role"] for field in result["sections"][3]["fields"]] == ["setpoint"]


def test_unregistered_cycle_time_survives_empty_hints(monkeypatch):
    payload = {"sections": [{"label": "监控", "fields": [
        _draft_field("周期时间", "actual", "s", [_draft_item(12.4, source="vlm")])
    ]}], "questions": ["请确认周期时间"]}
    monkeypatch.setattr(vlm_qwen, "_text_completion",
                        lambda *_: _draft_response(payload))

    result = vlm_qwen.draft_from_ocr(
        {"lines": [{"text": "周期时间 12.4 s"}]}, "", "trial", {}, [])

    assert result["sections"][0]["fields"][0]["canonical_id"] is None
    assert result["sections"][0]["fields"][0]["screen_label"] == "周期时间"


def test_draft_merges_equal_observations_and_keeps_conflicts(monkeypatch):
    fields = [
        _draft_field("射胶速度", "setpoint", "mm/s", [
            _draft_item(80, "1段", "ocr", "OCR: 1段 80")]),
        _draft_field("射胶速度", "setpoint", "mm/s", [
            _draft_item(80, "1段", "vlm", "图片: 1段 80")]),
        _draft_field("射胶速度", "setpoint", "mm/s", [
            _draft_item(79, "1段", "vlm", "图片: 1段 79")]),
    ]
    monkeypatch.setattr(vlm_qwen, "_text_completion", lambda *_: _draft_response(
        {"sections": [{"label": "射胶", "fields": fields}], "questions": []}))

    result = vlm_qwen.draft_from_ocr(
        {"lines": [{"text": "射胶速度 80"}]}, "", "trial", {}, [{
            "field_id": "stage_velocity", "label": "射胶速度", "unit": "mm/s",
            "shape": "array", "role": "setpoint"}])
    field = result["sections"][0]["fields"][0]

    assert field["canonical_id"] == "stage_velocity"
    assert [item["value"] for item in field["items"]] == [80, 79]
    assert field["items"][0]["sources"] == ["ocr", "vlm"]
    assert field["items"][0]["evidence"] == ["OCR: 1段 80", "图片: 1段 80"]


def test_draft_keeps_equal_temperatures_in_unlabelled_cells(monkeypatch):
    values = [220, 230, 230, 220, 220, 210]
    items = [_draft_item(value, None, "vlm", f"设定温度行第 {i + 1} 格")
             for i, value in enumerate(values)]
    payload = {"sections": [{"label": "温度", "fields": [
        _draft_field("设定温度", "setpoint", "°C", items)]}], "questions": []}
    monkeypatch.setattr(vlm_qwen, "_text_completion",
                        lambda *_: _draft_response(payload))

    result = vlm_qwen.draft_from_ocr({"lines": [{"text": "设定温度"}]})

    assert result["sections"][0]["fields"][0]["items"] == items


def test_draft_strict_output_limits_and_confirmation(monkeypatch):
    item = _draft_item(1)
    field = _draft_field("字段", "unknown", "", [item])
    valid_section = {"label": "区域", "fields": [field]}
    bad_source = _draft_item(1)
    bad_source["sources"] = ["camera"]
    empty_evidence = _draft_item(1)
    empty_evidence["evidence"] = [""]
    extra_key = _draft_item(1)
    extra_key["unexpected"] = True
    cases = [
        {"sections": [valid_section], "questions": ["?"] * 33},
        {"sections": [{"label": str(i), "fields": [field]} for i in range(33)],
         "questions": []},
        {"sections": [{"label": "区域", "fields": [
            _draft_field(f"字段{i}", "unknown", "", [_draft_item(i)])
            for i in range(257)]}], "questions": []},
        {"sections": [{"label": "区域", "fields": [
            _draft_field("字段", "unknown", "", [
                _draft_item(i, str(i)) for i in range(1025)])
        ]}], "questions": []},
        {"sections": [{"label": "区域", "fields": [
            _draft_field("字段", "unknown", "", [bad_source])
        ]}], "questions": []},
        {"sections": [{"label": "区域", "fields": [
            _draft_field("字段", "unknown", "", [empty_evidence])
        ]}], "questions": []},
        {"sections": [{"label": "区域", "fields": [
            _draft_field("字段", "unknown", "", [extra_key])
        ]}], "questions": []},
        {"sections": [{"label": "区域", "fields": [
            _draft_field("字段", "unknown", "", [_draft_item(float("nan"))])
        ]}], "questions": []},
    ]
    unconfirmed = _draft_field("字段", "unknown", "", [_draft_item(1)])
    unconfirmed["needs_confirmation"] = False
    cases.append({"sections": [{"label": "区域", "fields": [unconfirmed]}],
                  "questions": []})

    for payload in cases:
        monkeypatch.setattr(vlm_qwen, "_text_completion",
                            lambda *_, value=payload: _draft_response(value))
        with pytest.raises(vlm_qwen.VlmError):
            vlm_qwen.draft_from_ocr(
                {"lines": [{"text": "字段 1"}]}, "", "trial", {}, [])


def test_draft_rejects_invalid_request_boundaries(monkeypatch):
    monkeypatch.setattr(vlm_qwen, "_text_completion",
                        lambda *_: pytest.fail("invalid input must not call VLM"))
    calls = [
        ({}, "", "x" * 201, {}, [], None),
        ({}, "x" * 2001, "trial", {}, [], None),
        ({"lines": [{"text": "x", "confidence": 2}]}, "", "trial", {}, [], None),
        ({"lines": [{"text": "x", "bbox": [0, 1, 2]}]}, "", "trial", {}, [], None),
        ({}, "", "trial", {"x": True}, [], None),
        ({}, "", "trial", {}, [{"field_id": "x", "label": "X", "unit": "",
                                  "shape": "scalar", "role": "bad"}], None),
        ({}, "", "trial", {}, [], b""),
    ]
    for args in calls:
        with pytest.raises(vlm_qwen.VlmError):
            vlm_qwen.draft_from_ocr(*args)


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


def test_draft_coerces_numeric_strings_and_defaults_empty_questions(monkeypatch):
    response_payload = {
        "sections": [{
            "label": "温度",
            "fields": [{
                "screen_label": "设定温度",
                "canonical_id": "barrel_temperature_set_c",
                "role": "setpoint",
                "unit": "°C",
                "items": [
                    {
                        "label": "喷嘴",
                        "value": "345.0",
                        "sources": ["ocr", "vlm"],
                        "evidence": ["OCR 345.0"],
                        "needs_confirmation": True,
                    },
                    {
                        "label": "前部",
                        "value": 340,
                        "sources": ["ocr", "vlm"],
                        "evidence": ["OCR 340"],
                        "needs_confirmation": True,
                    },
                ],
                "sources": ["ocr", "vlm"],
                "evidence": ["OCR 345.0", "OCR 340"],
                "needs_confirmation": True,
            }],
        }],
    }
    monkeypatch.setattr(vlm_qwen, "_text_completion",
                        lambda *_: {"choices": [{"message": {"content": json.dumps(response_payload)}}]})
    result = vlm_qwen.draft_from_ocr(
        {"lines": [{"text": "设定温度 345.0 340.0"}]}, "", "trial", {}, [
            {"field_id": "barrel_temperature_set_c", "label": "设定温度", "unit": "°C",
             "shape": "array", "role": "setpoint"},
        ])

    assert result["questions"] == []
    items = result["sections"][0]["fields"][0]["items"]
    assert items[0]["value"] == 345
    assert items[1]["value"] == 340


def test_draft_default_context_combines_image_and_ocr(monkeypatch):
    image = io.BytesIO()
    Image.new("RGB", (2, 2), "white").save(image, "PNG")
    captured = []
    payload = {"sections": [], "questions": []}
    monkeypatch.setattr(vlm_qwen, "_chat_completion", lambda _image, prompt, *_:
                        captured.append(json.loads(prompt.split("输入：", 1)[1]))
                        or _draft_response(payload))
    monkeypatch.setattr(vlm_qwen, "_text_completion",
                        lambda *_: pytest.fail("default must retain the image"))

    result = vlm_qwen.draft_from_ocr(
        {"lines": [{"text": "背压 12 bar"}]}, image_bytes=image.getvalue())

    assert captured[0]["target"] == ""
    assert captured[0]["current_structure"] == {}
    assert captured[0]["canonical_hints"] == []
    assert captured[0]["ocr_lines"] == [{"text": "背压 12 bar"}]
    assert result["sections"] == []
    assert result["questions"] == ["未提取到可核对的工艺参数，请核对原图或补拍清晰完整画面。"]


def test_draft_explicit_text_mode_and_invalid_mode(monkeypatch):
    monkeypatch.setattr(vlm_qwen, "_chat_completion",
                        lambda *_: pytest.fail("explicit text mode must stay text-only"))
    monkeypatch.setattr(vlm_qwen, "_text_completion", lambda *_:
                        _draft_response({"sections": [], "questions": ["表头不可读"]}))
    evidence = {"lines": [{"text": "12 bar"}]}

    result = vlm_qwen.draft_from_ocr(evidence, image_bytes=b"unused", mode="ocr_text")
    assert result["questions"] == ["表头不可读"]
    with pytest.raises(vlm_qwen.VlmError, match="候选请求上下文非法"):
        vlm_qwen.draft_from_ocr(evidence, mode="typo")


def test_draft_keeps_visible_zones_when_cropped_section_has_no_fields(monkeypatch):
    payload = {"sections": [
        {"label": "温区1", "fields": [
            _draft_field("SV", "setpoint", "°C", [_draft_item(200)])]},
        {"label": "温区2", "fields": []},
    ], "questions": ["温区2数值被截断，请补拍。"]}
    monkeypatch.setattr(vlm_qwen, "_text_completion", lambda *_: _draft_response(payload))

    result = vlm_qwen.draft_from_ocr({"lines": [{"text": "SV 200"}]})

    assert [section["label"] for section in result["sections"]] == ["温区1"]
    assert result["sections"][0]["fields"][0]["items"][0]["value"] == 200
    assert result["questions"] == payload["questions"]
    payload["questions"] = []
    with pytest.raises(vlm_qwen.VlmError, match="VLM section 非法"):
        vlm_qwen.draft_from_ocr({"lines": [{"text": "SV 200"}]})


def test_draft_prompt_honors_explicit_extraction_scope(monkeypatch):
    requirement = '只提取设定温度和实际温度，不要偏差和输出百分比'
    def completion(prompt, _base_url, _model):
        request = json.loads(prompt.split('输入：', 1)[1])
        assert request['user_message'] == requirement
        assert '用户只要某些参数或角色时，只输出这些参数和角色' in prompt
        assert '未指定范围时整理所有可读工艺参数' in prompt
        assert '提取范围内即使没有 canonical hint' in prompt
        return _draft_response({'sections': [], 'questions': ['未读到实际温度']})
    monkeypatch.setattr(vlm_qwen, '_text_completion', completion)
    result = vlm_qwen.draft_from_ocr({'lines': [{'text': '设定温度 200'}]}, requirement)
    assert result['questions'] == ['未读到实际温度']


@pytest.mark.parametrize('label,count', [('第 1 段', 1), (None, 2)])
def test_draft_duplicate_observations_do_not_fail_batch(monkeypatch, label, count):
    field = _draft_field('设定温度', 'setpoint', '℃', [_draft_item(220, label)])
    payload = {'sections': [{'label': '料筒', 'fields': [field, field]}], 'questions': []}
    monkeypatch.setattr(vlm_qwen, '_text_completion', lambda *_: _draft_response(payload))
    result = vlm_qwen.draft_from_ocr({'lines': [{'text': '设定温度 220'}]})
    items = result['sections'][0]['fields'][0]['items']
    assert len(items) == count
    assert all(item['value'] == 220 and item['needs_confirmation'] for item in items)
