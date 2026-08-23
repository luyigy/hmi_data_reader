import asyncio
import json
import re
import sys
from pathlib import Path

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

    assert asyncio.run(hmi_service.authenticate_recognition(denied, ok)).status_code == 401
    assert asyncio.run(hmi_service.authenticate_recognition(allowed, ok)).status_code == 200
