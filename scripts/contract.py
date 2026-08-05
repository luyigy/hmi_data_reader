"""契约附加（023_DECISION）：将 contracts/ 字段目录与 Profile 注册表附加到提取结果。

纯 stdlib。attach_contract 幂等：extract 内调用一次（无分类置信度），
service 内带 classification 再调用一次（重算 profile_confidence），
全部新增键直接写在 result 顶层，不改动 fields/status/warnings 等既有键。

新增顶层键：
- contract_version   字段目录版本
- hmi_variant        layout_variant 或 "unknown"（替代旧硬编码 "v1"）
- profile_id         <controller_family>.<page_type>.<layout_variant>，三段不齐为 None
- profile_confidence 分类置信度最小值；无分类 0.7；无 layout_variant 封顶 0.69
- profile_status     profiles 注册表 status；未登记或 profile_id 为 None -> "unknown"
- field_meta         仅目录中存在的字段：label_zh/page_label_zh/unit/role/entity/
                     value_type/web_target（role 应用 role_overrides[profile_id]；
                     physical_semantics 仅在目录中定义时原样带上）
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRACTS_DIR = REPO_ROOT / "contracts"
TEMPLATES_DIR = REPO_ROOT / "templates"

# 无可用分类置信度时的默认值（profiles.apply_thresholds.candidate_min_confidence）
DEFAULT_CONFIDENCE = 0.7
# layout_variant 解析失败时的置信度上限（低于 candidate 门槛，禁止应用）
NO_LAYOUT_CONFIDENCE_CAP = 0.69


@lru_cache(maxsize=1)
def _field_catalog() -> dict:
    return json.loads((CONTRACTS_DIR / "field_catalog.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _profile_registry() -> dict:
    data = json.loads((CONTRACTS_DIR / "profiles.json").read_text(encoding="utf-8"))
    return {p["profile_id"]: p for p in data.get("profiles", [])}


@lru_cache(maxsize=None)
def _template_heater_mode(family: str, page_type: str) -> str | None:
    """temperature 页的 layout_variant = 模板 heater_columns.mode。"""
    path = TEMPLATES_DIR / f"{family.lower()}.{page_type}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    heater = data.get("heater_columns")
    if isinstance(heater, dict):
        mode = heater.get("mode")
        if isinstance(mode, str) and mode:
            return mode
    return None


def _resolve_layout_variant(result: dict) -> str | None:
    page_type = result.get("page_type")
    if page_type == "injection_metering":
        detail = result.get("extraction_detail")
        if isinstance(detail, dict):
            variant = detail.get("page_variant")
            if isinstance(variant, str) and variant:
                return variant
        return None
    if page_type == "temperature":
        family = result.get("controller_family")
        if isinstance(family, str) and family:
            return _template_heater_mode(family, page_type)
    return None


def _usable_confidence(value) -> float | None:
    """容忍 int/float；0..1 之外（含 bool/None/字符串）视为不可用。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if 0 <= value <= 1:
        return float(value)
    return None


def _classification_confidence(classification: dict | None) -> float | None:
    """取 ui_family_confidence / page_confidence 中可用者的最小值；无可用者返回 None。"""
    if not isinstance(classification, dict):
        return None
    usable = [
        c for c in (
            _usable_confidence(classification.get("ui_family_confidence")),
            _usable_confidence(classification.get("page_confidence")),
        )
        if c is not None
    ]
    return min(usable) if usable else None


def _build_field_meta(fields: dict | None, catalog_fields: dict,
                      profile_id: str | None) -> dict:
    field_meta = {}
    if not isinstance(fields, dict):
        return field_meta
    for name in fields:
        spec = catalog_fields.get(name)
        if not isinstance(spec, dict):
            continue
        meta = {
            "label_zh": spec.get("label_zh"),
            "page_label_zh": spec.get("page_label_zh"),
            "unit": spec.get("unit"),
            "role": spec.get("role"),
            "entity": spec.get("entity"),
            "value_type": spec.get("value_type"),
            "web_target": spec.get("web_target"),
        }
        overrides = spec.get("role_overrides")
        if profile_id and isinstance(overrides, dict) and profile_id in overrides:
            meta["role"] = overrides[profile_id]
        if "physical_semantics" in spec:
            meta["physical_semantics"] = spec.get("physical_semantics")
        field_meta[name] = meta
    return field_meta


def attach_contract(result: dict, classification: dict | None = None) -> dict:
    """把契约键写入 result 顶层并返回 result（原地修改，幂等）。"""
    catalog = _field_catalog()
    registry = _profile_registry()

    layout_variant = _resolve_layout_variant(result)
    result["hmi_variant"] = layout_variant or "unknown"

    family = result.get("controller_family")
    page_type = result.get("page_type")
    profile_id = None
    if (isinstance(family, str) and family
            and isinstance(page_type, str) and page_type
            and layout_variant):
        profile_id = f"{family.lower()}.{page_type}.{layout_variant}"
    result["profile_id"] = profile_id

    profile = registry.get(profile_id) if profile_id else None
    result["profile_status"] = profile["status"] if profile else "unknown"

    confidence = _classification_confidence(classification)
    if confidence is None:
        confidence = DEFAULT_CONFIDENCE
    if layout_variant is None:
        confidence = min(confidence, NO_LAYOUT_CONFIDENCE_CAP)
    result["profile_confidence"] = round(confidence, 3)

    result["contract_version"] = catalog.get("contract_version")
    result["field_meta"] = _build_field_meta(
        result.get("fields"), catalog.get("fields", {}), profile_id)
    return result
