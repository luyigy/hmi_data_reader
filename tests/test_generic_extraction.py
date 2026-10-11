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
from extract_fields import extract_one, route_family, route_page  # noqa: E402
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


def test_feishu_uses_the_same_generic_page_result(tmp_path: Path, monkeypatch):
    import cv2
    import numpy as np
    import feishu_card_assistant as card
    from quality import QualityReport

    source = tmp_path / 'unknown_screen.png'
    cv2.imwrite(str(source), np.zeros((120, 300, 3), dtype=np.uint8))
    lines = [_line('保压时间', 10, 10, 80, 25), _line('2.5', 90, 10, 120, 25)]
    meta = {'ok': True, 'screen_size': [300, 120], 'method': 'test'}

    def rectify(_source, target, metadata):
        cv2.imwrite(str(target), np.zeros((120, 300, 3), dtype=np.uint8))
        metadata.write_text(json.dumps(meta))
        return meta

    monkeypatch.setattr(card, 'rectify', rectify)
    monkeypatch.setattr(card, 'assess', lambda _: QualityReport(filename='fixture', triage='green'))
    monkeypatch.setattr(card, 'run_ocr_for_image', lambda _: lines)
    monkeypatch.setattr(card, 'TEMPLATES_DIR', tmp_path / 'no_templates')
    result = card.process_hmi_image(source, tmp_path / 'work')
    direct = extract_one(source.stem, tmp_path / 'work/rectified', None, None, card.TEMPLATES_DIR)
    assert (result['status'], result['fields'], result['profile_id']) == (
        direct['status'], direct['fields'], direct['profile_id'])
    assert result['provenance']['page_source'] == direct['provenance']['page_source']


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


def test_tact_temperature_columns_override_monitor_tab():
    lines = [_line(text, 0, y, 10, y + 5) for y, text in enumerate(
        ("喷聘", "简头", "前部", "中部", "后部", "下口", "监视"))]

    family, source = route_family("image", lines, None, None)
    page, page_source = route_page("image", lines, family)

    assert (family, source) == ("TACT", "temperature_columns")
    assert (page, page_source) == ("temperature", "template_anchors")


def test_partial_temperature_columns_do_not_force_tact():
    lines = [_line(text, 0, y, 10, y + 5) for y, text in enumerate(
        ("前部", "中部", "后部", "监视"))]

    assert route_family("image", lines, None, None)[0] == "unknown"


def test_draft_endpoint_passes_open_candidate_context(monkeypatch):
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
        '"shape":"scalar","role":"setpoint"}]', "保压时间=2.5", json.dumps(evidence)))

    assert result == candidate
    assert captured == {"args": (
        evidence, "保压时间=2.5", "normal_trial.holding",
        {"holding_segments": 3}, [{
            "field_id": "holding_time", "label": "保压时间", "unit": "s",
            "shape": "scalar", "role": "setpoint",
        }], captured["args"][-2], "vision")}
    assert captured["args"][-2] == upload.file.getvalue()


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
    """Legacy recognition failures stay on that route, never gate draft."""
    async def busy(_file):
        raise HTTPException(status_code=status_code, detail="Recognition failed")

    monkeypatch.setattr(hmi_service, "recognize_image", busy)
    monkeypatch.setattr(hmi_service, "is_ready", False)
    monkeypatch.setattr(hmi_service, "draft_from_ocr", lambda *_args: {
        "sections": [], "questions": []})
    result = asyncio.run(hmi_service.draft_image(_upload()))
    assert result["sections"] == []
    assert "OCR" in result["questions"][0]
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(hmi_service.recognize_image(_upload()))
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


@pytest.mark.parametrize("mode", [None, "vision", "ocr_text"])
@pytest.mark.parametrize("ocr_state", ["ready", "failed", "unavailable", "supplied"])
def test_draft_image_only_http_and_mode(monkeypatch, mode, ocr_state):
    import httpx
    import ocr_variants

    evidence = {"lines": [{"text": "冷却时间 3 s"}]}
    calls = []

    def forbidden(*_args, **_kwargs):
        pytest.fail("draft must not classify, extract or recognize a page")

    def raw_ocr(_model, path):
        assert hmi_service.concurrency_semaphore.locked()
        assert path.is_file()
        assert ocr_state != "supplied", "supplied evidence must skip OCR"
        calls.append("ocr")
        if ocr_state == "failed":
            raise RuntimeError("OCR unavailable")
        return [{"text": "冷却时间 3 s", "conf": 0.9,
                 "bbox": {"x_min": 0, "y_min": 0, "x_max": 1, "y_max": 1}}]

    def draft(*args):
        assert hmi_service.concurrency_semaphore.locked()
        calls.append(args)
        return {"sections": [], "questions": ["请确认原图。"]}

    monkeypatch.setenv("HMI_API_KEY", "reader-secret")
    monkeypatch.setattr(hmi_service, "is_ready", ocr_state != "unavailable")
    monkeypatch.setattr(hmi_service, "ocr_model", object())
    monkeypatch.setattr(ocr_variants, "run_ocr", raw_ocr)
    for name in ("recognize_image", "classify", "extract_one"):
        monkeypatch.setattr(hmi_service, name, forbidden)
    monkeypatch.setattr(hmi_service, "draft_from_ocr", draft)
    content = _upload().file.getvalue()

    async def run():
        semaphore = asyncio.Semaphore(1)
        monkeypatch.setattr(hmi_service, "concurrency_semaphore", semaphore)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=hmi_service.app),
                                    base_url="http://test") as client:
            data = {} if mode is None else {"mode": mode}
            if ocr_state == "supplied":
                data["ocr_evidence"] = json.dumps(evidence)
            response = await client.post("/api/v1/draft", data=data,
                files={"file": ("screen.png", content, "image/png")},
                headers={"Authorization": "Bearer reader-secret"})
        assert not semaphore.locked()
        return response

    response = asyncio.run(run())
    assert response.status_code == 200
    args = calls[-1]
    assert args[1:] == ("", "", {}, [], content, mode or "vision")
    if ocr_state in {"failed", "unavailable"}:
        assert args[0] == {"lines": []}
        assert len(response.json()["questions"]) == 2
    elif ocr_state == "supplied":
        assert args[0] == evidence and len(calls) == 1
    else:
        assert calls[0] == "ocr"
        assert args[0]["screen_size"] == [2, 2]
        assert args[0]["lines"][0]["bbox"] == [0, 0, 1, 1]


@pytest.mark.parametrize("data,content,authorized,expected", [
    ({}, None, False, 401),
    ({"mode": "invalid"}, None, True, 422),
    ({"current_structure": "null"}, None, True, 422),
    ({"allowed_fields": "null"}, None, True, 422),
    ({"ocr_evidence": "null"}, None, True, 422),
    ({}, b"broken", True, 400),
    ({}, b"x" * (20 * 1024 * 1024 + 1), True, 422),
])
def test_draft_http_input_boundaries(monkeypatch, data, content, authorized, expected):
    import httpx

    monkeypatch.setenv("HMI_API_KEY", "reader-secret")
    monkeypatch.setattr(hmi_service, "draft_from_ocr", lambda *_args: pytest.fail(
        "invalid input must not reach model"))

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=hmi_service.app),
                                    base_url="http://test") as client:
            return await client.post("/api/v1/draft", data=data,
                files={"file": ("screen.png", content if content is not None
                                 else _upload().file.getvalue(), "image/png")},
                headers={"Authorization": "Bearer reader-secret"} if authorized else {})

    assert asyncio.run(run()).status_code == expected
