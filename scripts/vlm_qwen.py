"""Qwen3-VL 客户端：HMI 屏幕字段抽取（测试验证用途，不接入生产管线）。

边界说明（2026-08-21 实测）：
- 本模块只负责"读字段值"，不做控制器家族/页面分类——Qwen3-VL-32B 实测会把
  KEBA 机台误判为生造品牌名，家族判定必须继续由机台档案/分类器提供。
- 调用方必须提供 page_type（来自真值元数据或分类结果），提示词按 field_catalog
  中 source_pages 匹配的字段子集生成。
- 图像预缩放至长边 <= MAX_IMAGE_EDGE：vLLM max_model_len=16384，原图实测
  prompt 占用约 11.8k tokens，必须留出生成余量。

配置（环境变量）：
- HMI_VLM_BASE_URL：默认 http://localhost:8003/v1
- HMI_VLM_MODEL：默认 Qwen3-VL-32B-Instruct
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import time
import urllib.request
import urllib.error
from pathlib import Path

from PIL import Image

from extract_generic import NUMBER_RE

BASE_URL = os.environ.get("HMI_VLM_BASE_URL", "http://localhost:8003/v1").rstrip("/")
MODEL = os.environ.get("HMI_VLM_MODEL", "Qwen3-VL-32B-Instruct")

MAX_IMAGE_EDGE = 1280
JPEG_QUALITY = 85
MAX_TOKENS = 2000
TIMEOUT_S = 180
MAX_RETRIES = 1

TEXT_BASE_URL = "http://localhost:8003/v1"
TEXT_MODEL = "Qwen3.8-27B-AWQ-INT4"


class VlmError(Exception):
    """VLM 调用或输出解析失败。"""


def _text_config() -> tuple[str, str]:
    base_url = os.environ.get("HMI_VLM_BASE_URL")
    model = os.environ.get("HMI_VLM_MODEL")
    if base_url != TEXT_BASE_URL or model != TEXT_MODEL:
        raise VlmError(
            f"文本评测必须显式设置 HMI_VLM_BASE_URL={TEXT_BASE_URL} "
            f"和 HMI_VLM_MODEL={TEXT_MODEL}"
        )
    return base_url.rstrip("/"), model


def check_text_model() -> None:
    """确认 8003 暴露目标模型；失败即受控停止。"""
    base_url, model = _text_config()
    try:
        with urllib.request.urlopen(f"{base_url}/models", timeout=10) as resp:
            payload = json.load(resp)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise VlmError(f"8003 模型检查失败：{exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise VlmError("8003 模型列表结构非法")
    models = {item.get("id") for item in payload["data"] if isinstance(item, dict)}
    if model not in models:
        raise VlmError(f"8003 未提供目标模型 {model!r}；当前模型：{sorted(models)}")


def build_text_prompt(evidence: dict, page_fields: dict) -> str:
    """只序列化当前页 OCR token 证据和 catalog 字段子集。"""
    tokens = evidence.get("tokens") or {}
    rows = evidence.get("rows") or []
    safe_evidence = {
        "page_type": evidence.get("page_type"),
        "tokens": {
            token_id: {key: token.get(key) for key in ("text", "conf", "bbox")}
            for token_id, token in tokens.items()
            if isinstance(token_id, str) and isinstance(token, dict)
        },
        "rows": [
            {key: row.get(key) for key in
             ("label_token_ids", "value_token_ids", "text", "order")}
            for row in rows if isinstance(row, dict)
        ],
        "supplements": evidence.get("supplements") or {},
    }
    safe_catalog = {
        key: {name: meta.get(name) for name in
              ("label_zh", "value_type", "unit", "role", "entity")}
        for key, meta in page_fields.items()
    }
    request = {"evidence": safe_evidence, "catalog_fields": safe_catalog}
    return (
        "只做 OCR token 到字段的语义归位。不得读取图片、猜测或返回任何业务数值。\n"
        "只输出严格 JSON："
        '{"mappings":[{"field":"...","value_token_ids":["t1"],'
        '"screen_order":"screen_left_to_right","active_count":1}],'
        '"unresolved":[],"notes":[]}。\n'
        "先用页面标题确定工序语义，再按同一行的标签、单位和空间位置映射；"
        "不得把无标签的实际值、状态值或相邻区域数值猜成设定字段。\n"
        "多级保压页中：速度[mm/s] 是 holding_velocity_mms，压力[bar] 是 "
        "stage_holding_pressure_bar，时间[s] 是 stage_holding_time_s；"
        "屏幕从左到右为反物理段序时必须用 reverse_physical，并用 active_count "
        "裁掉反转后末尾的禁用槽。\n"
        "数组可用 screen_order=reverse_physical；active_count 仅表示启用段数。\n"
        f"输入：{json.dumps(request, ensure_ascii=False, separators=(',', ':'))}"
    )


def _text_completion(prompt: str, base_url: str, model: str) -> dict:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            return json.load(resp)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise VlmError(f"VLM 文本请求失败：{exc}") from exc


def draft_from_ocr(evidence: dict, user_message: str, target: str,
                   current_structure: dict, allowed_fields: list[dict]) -> dict:
    """Return strictly validated candidates limited to caller-approved fields."""
    if (not isinstance(evidence, dict)
            or not isinstance(target, str) or not target.strip()
            or not isinstance(user_message, str)
            or not isinstance(current_structure, dict)
            or any(not isinstance(key, str) or isinstance(value, bool)
                   or not isinstance(value, int) or value < 1
                   for key, value in current_structure.items())
            or not isinstance(allowed_fields, list)):
        raise VlmError("候选请求上下文非法")
    allowed = {}
    for field in allowed_fields:
        if (not isinstance(field, dict)
                or set(field) != {"field_id", "label", "unit", "shape"}
                or not isinstance(field["field_id"], str) or not field["field_id"]
                or not isinstance(field["label"], str)
                or not isinstance(field["unit"], str)
                or not isinstance(field["shape"], str)
                or field["shape"] not in {"scalar", "array"}
                or field["field_id"] in allowed):
            raise VlmError("允许字段定义非法")
        allowed[field["field_id"]] = field
    lines = [
        {key: line.get(key) for key in ("text", "confidence", "bbox")}
        for line in evidence.get("lines", [])
        if isinstance(line, dict) and isinstance(line.get("text"), str)
        and line["text"].strip()
    ]
    if not lines:
        return {"candidates": [], "structure_suggestion": {},
                "questions": ["OCR 未识别到文字，请重拍。"]}
    request = {"target": target.strip(), "current_structure": current_structure,
               "allowed_fields": allowed_fields, "ocr_lines": lines,
               "user_message": user_message.strip()}
    prompt = (
        "只把 OCR 原文和用户纠正归位到 allowed_fields。禁止返回白名单外字段，"
        "禁止猜测、换算单位、生成数据库路径或持久化；用户纠正优先于 OCR。\n"
        "只输出严格 JSON："
        '{"candidates":[{"field_id":"白名单ID","values":1.0,"unit":"s",'
        '"evidence":["完整OCR原文"],"status":"needs_confirmation"}],'
        '"structure_suggestion":{},"questions":[]}。'
        "scalar 的 values 是数字，array 是非空数字数组；evidence 必须逐字引用完整 OCR 行。\n"
        f"输入：{json.dumps(request, ensure_ascii=False, separators=(',', ':'))}"
    )
    base_url = os.getenv("HMI_DRAFT_VLM_BASE_URL", TEXT_BASE_URL).rstrip("/")
    model = os.getenv("HMI_DRAFT_VLM_MODEL", TEXT_MODEL)
    response = _text_completion(prompt, base_url, model)
    try:
        content = response["choices"][0]["message"]["content"].strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        draft = json.loads(content)
    except (KeyError, IndexError, TypeError, AttributeError, json.JSONDecodeError) as exc:
        raise VlmError("VLM 候选响应不是合法 JSON") from exc
    if (not isinstance(draft, dict)
            or set(draft) != {"candidates", "structure_suggestion", "questions"}
            or not isinstance(draft["candidates"], list)
            or not isinstance(draft["structure_suggestion"], dict)
            or not isinstance(draft["questions"], list)
            or any(not isinstance(question, str) for question in draft["questions"])):
        raise VlmError("VLM 候选响应结构非法")
    ocr_texts = {line["text"] for line in lines}
    seen = set()
    for candidate in draft["candidates"]:
        if (not isinstance(candidate, dict)
                or set(candidate) != {"field_id", "values", "unit", "evidence", "status"}
                or not isinstance(candidate.get("field_id"), str)
                or candidate["field_id"] not in allowed
                or candidate["field_id"] in seen
                or candidate.get("unit") != allowed[candidate["field_id"]]["unit"]
                or candidate.get("status") != "needs_confirmation"
                or not isinstance(candidate.get("evidence"), list)
                or not candidate["evidence"]
                or any(not isinstance(item, str) or item not in ocr_texts
                       for item in candidate["evidence"])):
            raise VlmError("VLM 候选字段、单位或证据非法")
        values = candidate.get("values")
        is_number = lambda value: (isinstance(value, (int, float))
                                   and not isinstance(value, bool)
                                   and value == value and abs(value) != float("inf"))
        if (allowed[candidate["field_id"]]["shape"] == "scalar"
                and not is_number(values)) or (
                allowed[candidate["field_id"]]["shape"] == "array"
                and (not isinstance(values, list) or not values
                     or any(not is_number(value) for value in values))):
            raise VlmError("VLM 候选值与字段 shape 不匹配")
        seen.add(candidate["field_id"])
    if any(not isinstance(key, str) or key not in current_structure
           or isinstance(value, bool)
           or not isinstance(value, int) or value < 1
           for key, value in draft["structure_suggestion"].items()):
        raise VlmError("VLM 结构建议非法")
    return draft


def _parse_mapping_output(resp: dict) -> dict:
    try:
        text = resp["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, AttributeError) as exc:
        raise VlmError("VLM 文本响应结构非法") from exc
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        output = json.loads(text)
    except json.JSONDecodeError as exc:
        raise VlmError(f"VLM 文本输出不是合法 JSON：{exc}") from exc
    if not isinstance(output, dict) or set(output) - {"mappings", "unresolved", "notes"}:
        raise VlmError("VLM 文本输出含未允许的顶层字段")
    if not isinstance(output.get("mappings"), list):
        raise VlmError("VLM 文本输出缺少 mappings 数组")
    if not all(isinstance(output.get(key, []), list)
               and all(isinstance(item, str) for item in output.get(key, []))
               for key in ("unresolved", "notes")):
        raise VlmError("unresolved/notes 必须是字符串数组")
    return output


def validate_text_mappings(output: dict, evidence: dict, page_fields: dict) -> dict:
    """校验引用并仅从 OCR token 文本构造业务数值。"""
    tokens = evidence.get("tokens") or {}
    rows = evidence.get("rows") or []
    stage_fields = {"stage_holding_velocity_mms", "stage_holding_pressure_bar",
                    "stage_holding_time_s"}
    mappings = list(output["mappings"])
    rate_ids = (evidence.get("supplements") or {}).get("rate_cell") or []
    if len(rate_ids) == 5 and {"control_percent", "drop_port_control_percent"} <= page_fields.keys():
        mappings = [mapping for mapping in mappings
                    if not isinstance(mapping, dict)
                    or mapping.get("field") not in {"control_percent", "drop_port_control_percent"}]
        mappings += [
            {"field": "control_percent", "value_token_ids": rate_ids[:4],
             "screen_order": "screen_left_to_right", "active_count": 4},
            {"field": "drop_port_control_percent", "value_token_ids": rate_ids[4:],
             "screen_order": "screen_left_to_right", "active_count": 1},
        ]
    multi_holding = (any("保压" in str(row.get("text", "")) for row in rows)
                     and any(isinstance(mapping, dict) and mapping.get("field") in stage_fields
                             for mapping in mappings))
    stage_count = 0
    if multi_holding:
        # ponytail: DEMAG multi-holding derives stages from active pressure/velocity
        # cells or time transitions; move this to profile metadata when another layout differs.
        for mapping in mappings:
            if not isinstance(mapping, dict) or mapping.get("field") not in stage_fields:
                continue
            texts = [str(tokens.get(token_id, {}).get("text", ""))
                     for token_id in mapping.get("value_token_ids", [])]
            values = [float(match.group()) for text in texts for match in NUMBER_RE.finditer(text)]
            nonzero = sum(value != 0 for value in values)
            transitions = 1 if mapping.get("field") == "stage_holding_time_s" else 0
            stage_count = max(stage_count, nonzero + transitions)
    used: set[str] = set()
    fields: dict = {}
    accepted = []
    allowed_keys = {"field", "value_token_ids", "screen_order", "active_count"}
    for mapping in mappings:
        if not isinstance(mapping, dict) or set(mapping) - allowed_keys:
            raise VlmError("mapping 含模型直接数值或其他未允许字段")
        mapping = dict(mapping)
        field = mapping.get("field")
        token_ids = mapping.get("value_token_ids")
        if field not in page_fields:
            raise VlmError(f"未知或跨页字段：{field!r}")
        if field in fields:
            raise VlmError(f"{field}: 字段重复映射")
        if (not isinstance(token_ids, list) or not token_ids
                or not all(isinstance(token_id, str) for token_id in token_ids)):
            raise VlmError(f"{field}: value_token_ids 必须是非空字符串数组")
        if len(token_ids) != len(set(token_ids)) or used.intersection(token_ids):
            raise VlmError(f"{field}: OCR token 重复占用")
        if any(token_id not in tokens for token_id in token_ids):
            raise VlmError(f"{field}: 引用了未知 OCR token")
        token_texts = [str(tokens[token_id].get("text", "")) for token_id in token_ids]
        if any(re.search(r"(?i)(?:\d[oijl]\b|[oijl]\d)", text) for text in token_texts):
            raise VlmError(f"{field}: OCR token 存在数字字母歧义")
        values = [float(match.group()) for text in token_texts for match in NUMBER_RE.finditer(text)]
        if not values:
            raise VlmError(f"{field}: OCR token 不含可解析数值")

        if multi_holding and field in stage_fields:
            row_text = " ".join(str(row.get("text", "")) for row in rows
                                if set(token_ids).issubset(row.get("value_token_ids") or []))
            anchor = {"stage_holding_velocity_mms": "速度",
                      "stage_holding_pressure_bar": "压力",
                      "stage_holding_time_s": "时间"}[field]
            if anchor not in row_text:
                raise VlmError(f"{field}: 多级保压业务行锚点缺失")
            mapping["screen_order"] = "reverse_physical"
            mapping["active_count"] = stage_count - (field == "stage_holding_time_s")

        expect_list = (page_fields[field].get("value_type") or "").startswith("list")
        order = mapping.get("screen_order", "screen_left_to_right")
        active_count = mapping.get("active_count")
        if order not in ("screen_left_to_right", "reverse_physical"):
            raise VlmError(f"{field}: 非法 screen_order")
        if expect_list:
            if (not isinstance(active_count, int) or isinstance(active_count, bool)
                    or not 1 <= active_count <= len(values)):
                raise VlmError(f"{field}: active_count 越界")
            if order == "reverse_physical":
                values.reverse()
            fields[field] = values[:active_count]
        else:
            if (len(values) != 1 or isinstance(active_count, bool)
                    or active_count not in (None, 1) or order != "screen_left_to_right"):
                raise VlmError(f"{field}: 标量引用结构非法")
            fields[field] = values[0]
        used.update(token_ids)
        accepted.append(mapping)
    return {"fields": fields, "mappings": accepted,
            "unresolved": output.get("unresolved", []), "notes": output.get("notes", [])}


def validate_text_mappings_partial(output: dict, evidence: dict,
                                   page_fields: dict) -> dict:
    """Keep valid mappings when a sibling mapping is unsafe."""
    accepted = {"fields": {}, "mappings": []}
    unresolved = list(output.get("unresolved", []))
    for mapping in output["mappings"]:
        try:
            accepted = validate_text_mappings(
                {"mappings": accepted["mappings"] + [mapping]}, evidence, page_fields)
        except VlmError as exc:
            field = mapping.get("field") if isinstance(mapping, dict) else None
            unresolved.append({"field": field, "reason": str(exc)})
    return {**accepted, "unresolved": unresolved, "notes": output.get("notes", [])}


def map_text_evidence(evidence: dict, catalog: dict,
                      field_names: set[str] | None = None) -> dict:
    """离线调用 8003，把当前页 OCR 文本证据映射为可审计字段。"""
    page_type = evidence.get("page_type")
    page_fields = fields_for_page(catalog, page_type)
    if field_names is not None:
        page_fields = {key: value for key, value in page_fields.items()
                       if key in field_names}
    if not page_fields:
        return {"fields": {}, "mappings": [], "unresolved": [], "notes": [],
                "usage": None, "latency_s": 0, "model": None}
    base_url, model = _text_config()
    prompt = build_text_prompt(evidence, page_fields)
    started = time.monotonic()
    resp = _text_completion(prompt, base_url, model)
    result = validate_text_mappings_partial(
        _parse_mapping_output(resp), evidence, page_fields)
    result.update({"usage": resp.get("usage"),
                   "latency_s": round(time.monotonic() - started, 3), "model": model})
    return result


def load_catalog(catalog_path: str | Path) -> dict:
    with open(catalog_path, encoding="utf-8") as f:
        return json.load(f)


def fields_for_page(catalog: dict, page_type: str) -> dict:
    """筛出 source_pages 含 page_type 的字段子集。"""
    return {
        key: meta
        for key, meta in catalog.get("fields", {}).items()
        if page_type in (meta.get("source_pages") or [])
    }


def _encode_image(image_path: str | Path) -> str:
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    if max(w, h) > MAX_IMAGE_EDGE:
        scale = MAX_IMAGE_EDGE / max(w, h)
        img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return base64.b64encode(buf.getvalue()).decode()


def build_prompt(page_type: str, page_fields: dict) -> str:
    """按字段目录子集生成抽取指令。数组字段说明物理段序，要求禁猜值。"""
    lines = [
        "这是一张注塑机 HMI 屏幕照片，页面类型为「%s」。" % page_type,
        "请从屏幕中抽取以下设定参数，输出一个严格 JSON 对象，不要输出任何其他文字。",
        "",
        "字段清单（JSON 键 = 英文字段键，括号内为中文标签/单位/说明）：",
    ]
    for key, meta in sorted(page_fields.items()):
        label = meta.get("label_zh") or key
        unit = meta.get("unit") or ""
        value_type = meta.get("value_type") or ""
        entity = meta.get("entity") or {}
        desc = f"- {key}（{label}"
        if unit:
            desc += f"，单位 {unit}"
        if value_type.startswith("list"):
            order = entity.get("order", "physical_stage")
            desc += f"，数值数组，按{('物理段序' if order == 'physical_stage' else order)}排列"
        else:
            desc += "，单一数值"
        desc += "）"
        lines.append(desc)
    lines += [
        "",
        "规则：",
        "1. 只输出屏幕上清楚可读的数值；看不清、被遮挡或屏幕上不存在该字段时，值输出 null。",
        "2. 禁止猜测、插值或根据经验补全任何数值。",
        "3. 数组字段按物理段序输出（段 1 = 靠近射嘴的第一段），且只包含启用的段："
        "屏幕上未启用的段（整列为空白、灰色禁用、或所有参数均为 0/无显示的占位列）一律不计入数组；"
        "只有该段确有有效设定值时才保留。段数类字段（如 injection_stages）同样只统计启用段。",
        "4. 输出格式：{\"fields\": {<字段键>: <数值或数组或 null>, ...}, "
        "\"unreadable\": [<读不清的字段键>...]}",
        "5. 数值只保留数字本身，不带单位符号。",
    ]
    return "\n".join(lines)


def _chat_completion(image_b64: str, prompt: str) -> dict:
    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_err = exc
            if attempt < MAX_RETRIES:
                time.sleep(2)
    raise VlmError(f"VLM 请求失败：{last_err}")


def _parse_output(resp: dict) -> tuple[dict, list[str]]:
    """从响应中解析 JSON；返回 (fields, parse_notes)。"""
    try:
        content = resp["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise VlmError("VLM 响应结构非法") from exc
    if not isinstance(content, str):
        raise VlmError("VLM 响应内容为空")
    notes: list[str] = []
    text = content.strip()
    # 容忍 ```json 包裹
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        notes.append("stripped_markdown_fence")
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as exc:
        raise VlmError(f"输出不是合法 JSON：{exc}; 原文前200字: {text[:200]!r}")
    fields = obj.get("fields")
    if not isinstance(fields, dict):
        raise VlmError(f"输出缺少 fields 对象：{str(obj)[:200]!r}")
    for key in obj.get("unreadable") or []:
        if key in fields and fields[key] is not None:
            notes.append(f"unreadable_but_valued:{key}")
    return fields, notes


def validate_fields(fields: dict, page_fields: dict) -> tuple[dict, list[str]]:
    """按 catalog 校验类型/数组结构；非法值降级为 null 并记录。"""
    cleaned: dict = {}
    errors: list[str] = []
    for key in page_fields:
        value = fields.get(key)
        if value is None:
            cleaned[key] = None
            continue
        expect_list = (page_fields[key].get("value_type") or "").startswith("list")
        if expect_list:
            if not isinstance(value, list) or not value:
                errors.append(f"{key}: 期望非空数组，得到 {type(value).__name__}")
                cleaned[key] = None
                continue
            nums = []
            for item in value:
                if isinstance(item, (int, float)) and not isinstance(item, bool):
                    nums.append(float(item))
                else:
                    errors.append(f"{key}: 数组元素非数值 {item!r}")
                    nums = None  # type: ignore[assignment]
                    break
            cleaned[key] = nums
        else:
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                cleaned[key] = float(value)
            else:
                errors.append(f"{key}: 期望数值，得到 {value!r}")
                cleaned[key] = None
    extra = sorted(set(fields) - set(page_fields))
    if extra:
        errors.append(f"未登记字段被忽略: {','.join(extra)}")
    return cleaned, errors


# 段数组分组：射胶侧与保压侧各自独立裁尾（段序语义互不影响）
_STAGE_COUNT_KEYS = {
    "injection": {"injection_stages", "fill_stages"},
    "holding": {"holding_stages"},
}


def _stage_group(key: str) -> str:
    return "holding" if "holding" in key else "injection"


def trim_disabled_stages(cleaned: dict, page_fields: dict) -> tuple[dict, list[str]]:
    """确定性裁掉尾部全零禁用段。

    HMI 屏幕常把未启用段显示为整列 0（而非空白），VLM 容易把它们计入数组。
    规则：同一分组（射胶/保压）内所有数组字段取「最后一个非零元素位置 + 1」的
    最大值为启用段数，全部数组裁到该长度，段数标量同步修正。
    真值语义：禁用段 = 该段所有参数均为 0（如 KEBA 四/五段 0.0 占位列）。
    """
    trimmed = dict(cleaned)
    notes: list[str] = []
    for group in ("injection", "holding"):
        list_keys = [
            k for k, meta in page_fields.items()
            if _stage_group(k) == group
            and (meta.get("value_type") or "").startswith("list")
            and isinstance(cleaned.get(k), list) and cleaned[k]
        ]
        if not list_keys:
            continue
        active = 0
        for k in list_keys:
            for i, v in enumerate(cleaned[k]):
                if v != 0:
                    active = max(active, i + 1)
        if active == 0:
            continue  # 全零无法判断启用段数，保持原样
        longest = max(len(cleaned[k]) for k in list_keys)
        if active < longest:
            notes.append(f"{group}: 裁掉 {longest - active} 个尾部全零禁用段")
            for k in list_keys:
                if len(trimmed[k]) > active:
                    trimmed[k] = trimmed[k][:active]
            for k in _STAGE_COUNT_KEYS[group]:
                if isinstance(trimmed.get(k), float) and trimmed[k] > active:
                    trimmed[k] = float(active)
    return trimmed, notes


def extract_fields(image_path: str | Path, page_type: str, catalog: dict,
                   reverse_stage_arrays: bool = False) -> dict:
    """对单张图抽取字段。返回 fields/校验错误/用量/延迟。

    reverse_stage_arrays：页面屏幕列序与物理段序相反且 VLM 未能自行反转时
    （如 DEMAG 保压页），先整体反转数组再做禁用段裁剪；该信息属于页面语义，
    应由调用方按 profile 配置提供，不让 VLM 猜。
    """
    page_fields = fields_for_page(catalog, page_type)
    if not page_fields:
        raise VlmError(f"catalog 中 page_type={page_type!r} 无任何字段")
    prompt = build_prompt(page_type, page_fields)
    image_b64 = _encode_image(image_path)
    started = time.time()
    resp = _chat_completion(image_b64, prompt)
    latency = time.time() - started
    raw_fields, notes = _parse_output(resp)
    cleaned, errors = validate_fields(raw_fields, page_fields)
    if reverse_stage_arrays:
        cleaned = {
            k: (list(reversed(v)) if isinstance(v, list) else v)
            for k, v in cleaned.items()
        }
        notes.append("stage_arrays_reversed")
    cleaned, trim_notes = trim_disabled_stages(cleaned, page_fields)
    notes.extend(trim_notes)
    return {
        "fields": cleaned,
        "validation_errors": errors,
        "parse_notes": notes,
        "usage": resp.get("usage"),
        "latency_s": round(latency, 2),
        "model": MODEL,
    }
