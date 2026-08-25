import asyncio
import io
import json
import re
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

import hmi_service  # noqa: E402
from extract_fields import extract_one  # noqa: E402
from extract_generic import extract_generic  # noqa: E402


def _line(text, x0, y0, x1, y1, conf=0.95):
    return {"text": text, "conf": conf,
            "bbox": {"x_min": x0, "y_min": y0, "x_max": x1, "y_max": y1}}


def _upload():
    _, encoded = hmi_service.cv2.imencode(
        ".png", hmi_service.np.zeros((2, 2, 3), dtype=hmi_service.np.uint8))
    return hmi_service.UploadFile(filename="screen.png", file=io.BytesIO(encoded.tobytes()))


def test_spatial_kv_and_dynamic_temperature_grid():
    lines = [
        _line("冷却时间", 10, 10, 80, 25), _line("3.5 s", 90, 10, 130, 25),
        _line("料筒温度", 10, 35, 80, 48),
        _line("设定", 10, 55, 45, 70),
        _line("200", 80, 55, 110, 70), _line("210", 130, 55, 160, 70),
        _line("220", 180, 55, 210, 70),
        _line("实际", 10, 80, 45, 95),
        _line("198", 82, 80, 112, 95), _line("209", 132, 80, 162, 95),
        _line("219", 182, 80, 212, 95),
    ]

    result = extract_generic({"lines": lines}, [300, 120], "temperature")

    assert result["fields"] == {
        "barrel_temperature_set_c": [200.0, 210.0, 220.0],
        "barrel_temperature_current_c": [198.0, 209.0, 219.0],
    }
    detail = result["detail"]
    assert detail["evidence"]["tokens"]["t0"]["text"] == "冷却时间"
    assert detail["evidence"]["rows"][0] == {
        "label_token_ids": ["t0"],
        "value_token_ids": ["t1"],
        "text": "冷却时间 3.5 s",
        "order": "screen_left_to_right",
    }
    assert {mapping["field"] for mapping in detail["mappings"]} == set(result["fields"])
    assert all(mapping["value_token_ids"] for mapping in detail["mappings"])
    mappings = {mapping["field"]: mapping for mapping in detail["mappings"]}
    for field, output in result["fields"].items():
        source_text = " ".join(detail["evidence"]["tokens"][token_id]["text"]
                               for token_id in mappings[field]["value_token_ids"])
        source_values = [float(value) for value in re.findall(
            r"(?<![\d.])-?\d+(?:\.\d+)?", source_text)]
        assert all(value in source_values for value in (output if isinstance(output, list) else [output]))
    assert detail["unresolved"][0]["field"] == "cooling_time_s"
    assert detail["unresolved"][0]["reason"] == "PAGE_OR_TYPE_MISMATCH"


def test_missing_grid_cell_is_unresolved_without_left_shift():
    lines = [
        _line("料筒温度", 10, 10, 80, 25),
        _line("设定", 10, 35, 45, 50),
        _line("200", 80, 35, 110, 50), _line("210", 130, 35, 160, 50),
        _line("220", 180, 35, 210, 50),
        _line("实际", 10, 60, 45, 75),
        _line("198", 82, 60, 112, 75), _line("219", 182, 60, 212, 75),
    ]

    result = extract_generic({"lines": lines}, [300, 100], "temperature")

    assert result["fields"] is None
    assert result["detail"]["mappings"] == []
    assert result["detail"]["unresolved"] == [{
        "field": "barrel_temperature_rows",
        "reason": "GRID_COLUMNS_UNALIGNED_OR_VALUE_INVALID",
        "label_token_ids": ["t1", "t5"],
        "value_token_ids": ["t2", "t3", "t4", "t6", "t7"],
    }]


def test_duplicate_scalar_label_is_unresolved():
    lines = [
        _line("保压时间", 10, 10, 80, 25), _line("2.5", 90, 10, 120, 25),
        _line("保压时间", 10, 40, 80, 55), _line("3.0", 90, 40, 120, 55),
    ]

    result = extract_generic({"lines": lines}, [300, 100], "injection_metering")

    assert result["fields"] is None
    assert result["detail"]["mappings"] == []
    assert result["detail"]["unresolved"] == [{
        "field": "holding_time_s",
        "reason": "LABEL_NOT_UNIQUE",
        "label_token_ids": ["t0", "t2"],
        "value_token_ids": [],
    }]


def test_extract_one_uses_review_fallback_and_generic_profile(tmp_path: Path):
    stem = "unknown_screen"
    (tmp_path / f"{stem}.rectify.json").write_text(json.dumps({
        "ok": True, "screen_size": [300, 120], "method": "test"}))
    (tmp_path / f"{stem}.ocr.json").write_text(json.dumps({"lines": [
        _line("保压时间", 10, 10, 80, 25), _line("2.5", 90, 10, 120, 25),
    ]}))

    result = extract_one(stem, tmp_path, None, None, tmp_path / "no_templates")

    assert result["status"] == "review"
    assert result["fields"] == {"holding_time_s": 2.5}
    assert result["profile_id"] == "generic.spatial"
    assert result["profile_status"] == "candidate"
    assert result["field_meta"]["holding_time_s"]["unit"] == "s"
    mapping = result["extraction_detail"]["mappings"][0]
    assert mapping == {"field": "holding_time_s",
                       "label_token_ids": ["t0"], "value_token_ids": ["t1"]}


def test_optional_bearer_token(monkeypatch):
    async def ok(_request):
        return JSONResponse({"ok": True})

    monkeypatch.setenv("HMI_API_KEY", "reader-secret")
    denied = Request({"type": "http", "method": "POST",
                      "path": "/api/v1/recognize", "headers": []})
    allowed = Request({"type": "http", "method": "POST",
                       "path": "/api/v1/recognize",
                       "headers": [(b"authorization", b"Bearer reader-secret")]})
    denied_draft = Request({"type": "http", "method": "POST",
                            "path": "/api/v1/draft", "headers": []})

    assert asyncio.run(hmi_service.authenticate_recognition(denied, ok)).status_code == 401
    assert asyncio.run(hmi_service.authenticate_recognition(allowed, ok)).status_code == 200
    assert asyncio.run(hmi_service.authenticate_recognition(denied_draft, ok)).status_code == 401


def test_draft_endpoint_passes_whitelisted_candidate_context(monkeypatch):
    evidence = {"lines": [{"text": "保压时间 2.5 s"}]}
    candidate = {"sections": [{"label": "保压", "fields": [{
        "screen_label": "保压时间", "canonical_id": "holding_time",
        "role": "setpoint", "unit": "s", "items": [],
        "sources": ["ocr"], "evidence": ["保压时间 2.5 s"],
        "needs_confirmation": True,
    }]}], "questions": []}
    captured = {}

    async def recognize(file):
        captured["file"] = file
        return {"ocr_evidence": evidence}

    def draft(*args):
        captured["args"] = args
        return candidate

    monkeypatch.setattr(hmi_service, "recognize_image", recognize)
    monkeypatch.setattr(hmi_service, "draft_from_ocr", draft)
    upload = _upload()

    result = asyncio.run(hmi_service.draft_image(
        upload, "normal_trial.holding", '{"holding_segments":3}',
        '[{"field_id":"holding_time","label":"保压时间","unit":"s",'
        '"shape":"scalar","role":"setpoint"}]', "保压时间=2.5"))

    assert result == candidate
    assert captured == {"file": upload, "args": (
        evidence, "保压时间=2.5", "normal_trial.holding",
        {"holding_segments": 3}, [{
            "field_id": "holding_time", "label": "保压时间", "unit": "s",
            "shape": "scalar", "role": "setpoint",
        }], captured["args"][-1])}
    assert captured["args"][-1] == upload.file.getvalue()


def test_draft_endpoint_reuses_supplied_ocr_evidence(monkeypatch):
    evidence = {"lines": [{"text": "保压时间 2.5 s"}]}
    candidate = {"sections": [{"label": "周期", "fields": [
        {"screen_label": "周期时间", "canonical_id": None, "role": "actual"},
        {"screen_label": "保压时间", "canonical_id": None, "role": "setpoint"},
    ]}], "questions": ["请确认"]}
    calls = []
    monkeypatch.setattr(hmi_service, "recognize_image", lambda _file: pytest.fail(
        "recognition must not run when OCR evidence is supplied"))
    monkeypatch.setattr(hmi_service, "draft_from_ocr", lambda *args: calls.append(args) or candidate)

    result = asyncio.run(hmi_service.draft_image(
        _upload(), "target", "{}", "[]", "", json.dumps(evidence)))

    assert result is candidate
    assert len(calls) == 1
    assert calls[0][:5] == (evidence, "", "target", {}, [])


@pytest.mark.parametrize("status_code", [400, 429, 500])
def test_draft_endpoint_preserves_recognition_failures(monkeypatch, status_code):
    async def busy(_file):
        raise HTTPException(status_code=status_code, detail="Recognition failed")

    monkeypatch.setattr(hmi_service, "recognize_image", busy)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(hmi_service.draft_image(_upload(), "target", "{}", "[]"))
    assert exc_info.value.status_code == status_code


def test_draft_endpoint_maps_context_and_vlm_failures(monkeypatch):
    async def recognized(_file):
        return {"ocr_evidence": {}}

    def fail_draft(*_args):
        raise hmi_service.VlmError("bad VLM")

    monkeypatch.setattr(hmi_service, "recognize_image", recognized)
    monkeypatch.setattr(hmi_service, "draft_from_ocr", fail_draft)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(hmi_service.draft_image(_upload(), "target", "{}", "[]"))
    assert exc_info.value.status_code == 502

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(hmi_service.draft_image(object(), "target", "{", "[]"))
    assert exc_info.value.status_code == 422


@pytest.mark.parametrize("content", [b"", b"not an image"])
def test_draft_endpoint_rejects_empty_or_invalid_images(content):
    upload = hmi_service.UploadFile(filename="screen.png", file=io.BytesIO(content))

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(hmi_service.draft_image(upload, "target", "{}", "[]"))

    assert exc_info.value.status_code == 400


@pytest.mark.parametrize("evidence,fields", [
    ({"lines": [{"text": ""}]}, []),
    ({"lines": []}, [{"field_id": "x", "label": "X", "unit": "",
                      "shape": "scalar"}]),
])
def test_draft_endpoint_maps_invalid_request_contract_to_422(monkeypatch, evidence, fields):
    monkeypatch.setattr(hmi_service, "draft_from_ocr", hmi_service.draft_from_ocr)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(hmi_service.draft_image(
            _upload(), "target", "{}", json.dumps(fields),
            ocr_evidence=json.dumps(evidence)))

    assert exc_info.value.status_code == 422


def test_draft_endpoint_applies_vlm_concurrency_limit(monkeypatch):
    async def run():
        semaphore = asyncio.Semaphore(1)
        monkeypatch.setattr(hmi_service, "concurrency_semaphore", semaphore)
        await semaphore.acquire()
        try:
            return await hmi_service.draft_image(
                _upload(), "target", "{}", "[]", ocr_evidence='{"lines":[]}')
        finally:
            semaphore.release()

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(run())

    assert exc_info.value.status_code == 429
