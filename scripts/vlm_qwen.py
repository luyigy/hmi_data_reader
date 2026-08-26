"""HMI VLM 客户端：生产候选草稿与离线字段抽取。

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
import math
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
MAX_TOKENS = int(os.environ.get("HMI_VLM_MAX_TOKENS", "8192"))
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
                   current_structure: dict, allowed_fields: list[dict],
                   image_bytes: bytes | None = None) -> dict:
    """Return strictly validated, open-schema HMI observations for review."""
    roles = {"setpoint", "actual", "limit", "unknown"}
    source_names = {"ocr", "vlm", "user"}

    def string(value, limit, *, nullable=False, empty=False):
        return ((nullable and value is None)
                or (isinstance(value, str) and len(value) <= limit
                    and (empty or bool(value.strip()))))

    def strings(value, limit, maximum, allowed=None):
        return (isinstance(value, list) and 0 < len(value) <= maximum
                and all(string(item, limit) and (allowed is None or item in allowed)
                        for item in value)
                and len(value) == len(set(value)))

    def number(value):
        return (isinstance(value, (int, float)) and not isinstance(value, bool)
                and math.isfinite(value))

    def _to_number(value):
        if number(value):
            return int(value) if isinstance(value, float) and value.is_integer() else value
        if isinstance(value, str):
            try:
                val = float(value.strip())
                if math.isfinite(val):
                    return int(val) if val.is_integer() else val
            except (ValueError, TypeError):
                pass
        return None

    if (not isinstance(evidence, dict)
            or not string(target, 200)
            or not string(user_message, 2000, empty=True)
            or not isinstance(current_structure, dict)
            or len(current_structure) > 64
            or any(not string(key, 200) or isinstance(value, bool)
                   or not isinstance(value, int) or value < 1
                   for key, value in current_structure.items())
            or not isinstance(allowed_fields, list) or len(allowed_fields) > 256
            or (image_bytes is not None
                and (not isinstance(image_bytes, bytes) or not image_bytes
                     or len(image_bytes) > 20 * 1024 * 1024))):
        raise VlmError("候选请求上下文非法")
    hints = {}
    for field in allowed_fields:
        if (not isinstance(field, dict)
                or set(field) != {"field_id", "label", "unit", "shape", "role"}
                or not string(field["field_id"], 200)
                or not string(field["label"], 200)
                or not string(field["unit"], 200, empty=True)
                or field["shape"] not in {"scalar", "array"}
                or field["role"] not in roles
                or field["field_id"] in hints):
            raise VlmError("canonical hint 定义非法")
        hints[field["field_id"]] = field
    raw_lines = evidence.get("lines", [])
    if not isinstance(raw_lines, list) or len(raw_lines) > 2000:
        raise VlmError("OCR evidence 非法")
    lines = []
    for line in raw_lines:
        if (not isinstance(line, dict) or not {"text"} <= set(line)
                or set(line) - {"text", "confidence", "bbox"}
                or not string(line["text"], 1000)
                or ("confidence" in line
                    and (not number(line["confidence"])
                         or not 0 <= line["confidence"] <= 1))
                or ("bbox" in line
                    and (not isinstance(line["bbox"], list)
                         or len(line["bbox"]) != 4
                         or any(not number(value) for value in line["bbox"])))):
            raise VlmError("OCR evidence 非法")
        lines.append({key: line[key] for key in ("text", "confidence", "bbox")
                      if key in line})
    if not lines and not image_bytes:
        return {"sections": [],
                "questions": ["没有图片或 OCR 文字可供识别。"]}
    request = {"target": target.strip(), "current_structure": current_structure,
               "canonical_hints": allowed_fields, "ocr_lines": lines,
               "user_message": user_message.strip()}
    model = os.getenv("HMI_DRAFT_VLM_MODEL", TEXT_MODEL)
    use_image = bool(image_bytes)
    prompt = (
        ("直接查看 HMI 图片，并结合 OCR 原文和用户纠正，" if use_image
         else "结合 OCR 原文和用户纠正，")
        + "整理屏幕上所有可读工艺参数；canonical_hints 仅供匹配，不是输出白名单。"
        "不得猜测、翻译或换算；用户纠正优先。设定/实际/限制/未知必须分别使用 "
        "setpoint/actual/limit/unknown，并拆成并列 field；证据不足用 unknown。\n"
        "只输出严格 JSON 对象，包含 sections 和 questions 两个键。section 只有 label/fields；field 只有 "
        "screen_label/canonical_id/role/unit/items/sources/evidence/needs_confirmation；"
        "item 只有 label/value/sources/evidence/needs_confirmation。value 必须是纯数字（int 或 float，非数字开关/状态项如 ON/OFF 等严禁输出，禁止把数字写成字符串）。canonical_id 先填 null，"
        "needs_confirmation 始终为 true，sources 只用 ocr/vlm/user。标量 item.label 为 null；"
        "分段或温区标签保留屏幕原文。相同值的 OCR/VLM 观测分开返回以便本地融合，"
        "冲突值都保留。即使没有 canonical hint，也必须返回目录外字段。\n"
        f"输入：{json.dumps(request, ensure_ascii=False, separators=(',', ':'))}"
    )
    if use_image:
        base_url = os.getenv("HMI_DRAFT_VLM_BASE_URL", BASE_URL).rstrip("/")
        response = _chat_completion(_encode_image_bytes(image_bytes), prompt, base_url, model)
    else:
        base_url = os.getenv("HMI_DRAFT_VLM_BASE_URL", TEXT_BASE_URL).rstrip("/")
        response = _text_completion(prompt, base_url, model)
    try:
        content = response["choices"][0]["message"]["content"].strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        draft = json.loads(content)
    except (KeyError, IndexError, TypeError, AttributeError, json.JSONDecodeError) as exc:
        raise VlmError("VLM 候选响应不是合法 JSON") from exc
    if isinstance(draft, dict) and "sections" in draft and "questions" not in draft:
        draft["questions"] = []
    if (not isinstance(draft, dict)
            or set(draft) != {"sections", "questions"}
            or not isinstance(draft["sections"], list) or len(draft["sections"]) > 32
            or not isinstance(draft["questions"], list)
            or len(draft["questions"]) > 32
            or any(not string(question, 500) for question in draft["questions"])):
        raise VlmError("VLM 候选响应结构非法")

    section_map = {}
    exact_observations = set()
    field_count = item_count = 0
    field_keys = {"screen_label", "canonical_id", "role", "unit", "items",
                  "sources", "evidence", "needs_confirmation"}
    item_keys = {"label", "value", "sources", "evidence", "needs_confirmation"}
    for section in draft["sections"]:
        if (not isinstance(section, dict) or set(section) != {"label", "fields"}
                or not string(section["label"], 500)
                or not isinstance(section["fields"], list) or not section["fields"]):
            raise VlmError("VLM section 非法")
        output_section = section_map.setdefault(
            section["label"], {"label": section["label"], "fields": {}, "order": []})
        for field in section["fields"]:
            field_count += 1
            if not isinstance(field, dict) or set(field) != field_keys:
                raise VlmError("VLM field 非法")
            if isinstance(field.get("sources"), str):
                field["sources"] = [field["sources"]]
            if isinstance(field.get("evidence"), str):
                field["evidence"] = [field["evidence"]]
            if (field_count > 256
                    or not string(field.get("screen_label"), 500)
                    or not string(field.get("canonical_id"), 500, nullable=True)
                    or field.get("role") not in roles
                    or not string(field.get("unit"), 500, empty=True)
                    or not isinstance(field.get("items"), list) or not field["items"]
                    or not strings(field.get("sources"), 500, 3, source_names)
                    or not strings(field.get("evidence"), 500, 32)
                    or field.get("needs_confirmation") is not True):
                raise VlmError("VLM field 非法")
            shape = ("scalar" if len(field["items"]) == 1
                     and isinstance(field["items"][0], dict)
                     and field["items"][0].get("label") is None else "array")
            matches = [hint["field_id"] for hint in hints.values()
                       if (hint["label"], hint["unit"], hint["shape"], hint["role"])
                       == (field["screen_label"], field["unit"], shape, field["role"])]
            canonical_id = matches[0] if len(matches) == 1 else (
                field["canonical_id"] if field["canonical_id"] in hints else None)
            if field["canonical_id"] not in {None, canonical_id, *hints}:
                raise VlmError("VLM canonical hint 匹配非法")
            item_sources = set()
            item_evidence = set()
            field_key = (field["screen_label"], field["role"], field["unit"])
            if field_key not in output_section["fields"]:
                output_section["order"].append(field_key)
                output_section["fields"][field_key] = {
                    "screen_label": field["screen_label"], "canonical_ids": [],
                    "role": field["role"], "unit": field["unit"], "items": {},
                    "item_order": [], "needs_confirmation": True,
                }
            output_field = output_section["fields"][field_key]
            output_field["canonical_ids"].append(canonical_id)
            for item in field["items"]:
                item_count += 1
                if not isinstance(item, dict) or set(item) != item_keys:
                    raise VlmError("VLM item 非法")
                if isinstance(item.get("sources"), str):
                    item["sources"] = [item["sources"]]
                if isinstance(item.get("evidence"), str):
                    item["evidence"] = [item["evidence"]]
                numeric_val = _to_number(item["value"])
                if (item_count > 1024
                        or not string(item.get("label"), 500, nullable=True)
                        or numeric_val is None
                        or not strings(item.get("sources"), 500, 3, source_names)
                        or not strings(item.get("evidence"), 500, 32)
                        or item.get("needs_confirmation") is not True):
                    raise VlmError("VLM item 非法")
                item["value"] = numeric_val
                observation = (section["label"], *field_key, item["label"], item["value"],
                               tuple(item["sources"]), tuple(item["evidence"]))
                if observation in exact_observations:
                    raise VlmError("VLM 返回完全重复候选")
                exact_observations.add(observation)
                item_sources.update(item["sources"])
                item_evidence.update(item["evidence"])
                item_key = (item["label"], item["value"])
                if item_key not in output_field["items"]:
                    output_field["item_order"].append(item_key)
                    output_field["items"][item_key] = dict(item)
                else:
                    merged = output_field["items"][item_key]
                    merged["sources"] = list(dict.fromkeys(merged["sources"] + item["sources"]))
                    merged["evidence"] = list(dict.fromkeys(merged["evidence"] + item["evidence"]))
                    if len(merged["evidence"]) > 32:
                        raise VlmError("VLM 融合后 evidence 超限")
            if set(field["sources"]) != item_sources or set(field["evidence"]) != item_evidence:
                field["sources"] = list(dict.fromkeys(field["sources"] + list(item_sources)))
                field["evidence"] = list(dict.fromkeys(field["evidence"] + list(item_evidence)))
                if not strings(field["sources"], 500, 3, source_names) or not strings(field["evidence"], 500, 32):
                    raise VlmError("VLM field 来源或证据未汇总 items")

    sections = []
    for section in section_map.values():
        fields = []
        for key in section["order"]:
            field = section["fields"][key]
            items = [field["items"][item_key] for item_key in field.pop("item_order")]
            if not items:
                continue
            canonical_ids = set(field.pop("canonical_ids"))
            field["canonical_id"] = canonical_ids.pop() if len(canonical_ids) == 1 else None
            field["items"] = items
            field["sources"] = list(dict.fromkeys(
                source for item in items for source in item["sources"]))
            field["evidence"] = list(dict.fromkeys(
                evidence for item in items for evidence in item["evidence"]))
            if len(field["evidence"]) > 32:
                raise VlmError("VLM 融合后 evidence 超限")
            fields.append(field)
        if fields:
            sections.append({"label": section["label"], "fields": fields})
    return {"sections": sections, "questions": draft["questions"]}


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
    return _encode_image_bytes(Path(image_path).read_bytes())


def _encode_image_bytes(content: bytes) -> str:
    try:
        img = Image.open(io.BytesIO(content)).convert("RGB")
    except (OSError, ValueError) as exc:
        raise VlmError("VLM 图片格式无效") from exc
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


def _chat_completion(image_b64: str, prompt: str,
                     base_url: str = BASE_URL, model: str = MODEL) -> dict:
    payload = {
        "model": model,
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
        f"{base_url}/chat/completions",
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
