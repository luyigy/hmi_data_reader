"""Expose the B&R injection/holding physical page to the review contract."""

# 观测输出层：接收已提取的字段，保留原值、单位来源、状态、图像框和问题，组装 v1/v2 合同。
# 本文件不再包含 v2 的标题/段号/数值定位过程。坐标回投使用公共 project_boxes。
# v2 的 unknown 启用态保持原语义，不因为目录整理而自动放行。


import cv2

from .layout import _visual_active_count
from .package import PROFILE, VERSION
from raw_contract import canonical_hash
from extract_families.coordinates import project_boxes
import copy


ROWS = {
    "injection.speed": "injection_velocity_pct",
    "injection.pressure": "injection_pressure_bar",
    "injection.end": "injection_position_mm",
    "holding.speed": "holding_velocity_pct",
    "holding.pressure": "holding_pressure_bar",
    "holding.time": "holding_time_s",
}

SCALARS = {
    "vp.position": "vp_switch_position_mm",
    "vp.switch.time": "vp_switch_time_s",
}




def b_and_r_page_observations(fields: dict, template: dict, source_tokens: dict | None = None,
                              *, stage_cells: dict | None = None,
                              layout_counts: dict | None = None,
                              raw_values: dict | None = None, image_path=None) -> dict:
    candidate = template["business_profile_candidate"]
    aliases = candidate["possible_names"]
    units = candidate["field_units"]
    observations = []
    last_injection = fields.get("injection_stages")
    source_tokens = source_tokens or {}
    gray = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE) if image_path is not None else None
    visual_counts = {section: count for section, cells in (stage_cells or {}).items()
                     if (count := _visual_active_count(cells, gray)) is not None
                     and count == fields.get(f"{section}_stages")}
    layout_counts = layout_counts or {}

    def add(field_id: str, alias_id: str, value, stage: int | None, token: dict | None):
        if value is None:
            return
        final_display = field_id == f"injection.end.{last_injection}"
        section = field_id.split(".")[0]
        box = token.get("bbox") if token else None
        count = layout_counts.get(section)
        verified = stage is not None and count is not None and stage <= count
        disabled = stage is not None and count is not None and stage > count
        state = "enabled" if verified else "disabled" if disabled else "unknown"
        observations.append(dict(
            label=aliases[alias_id][0].replace("{n}", str(stage)), value=value,
            unit=units[alias_id], role="unknown" if final_display else "setting",
            section=section if section in {"injection", "holding"} else "scalar",
            stage=stage, state=state,
            state_basis="verified_physical_layout" if stage and count is not None else None,
            text=token["text"] if token else str(value),
            confidence=token.get("conf", 0.0) if token else 0.0,
            bbox=box, original_bbox=None,
            line_indexes=[token["line_index"]] if token and "line_index" in token else [], reasons=(["source_box_unavailable"] if box is None else []) +
            (["stage_state_unverified"] if stage and state == "unknown" else []) +
            (["low_confidence"] if not token or token.get("conf", 0) < .8 else []),
        ))

    for prefix, source in ROWS.items():
        for number, value in enumerate((raw_values or fields).get(source) or [], 1):
            tokens = source_tokens.get(source) or []
            add(f"{prefix}.{number}", f"{prefix}.{{n}}", value, number,
                tokens[number - 1] if number <= len(tokens) else None)
    for field_id, source in SCALARS.items():
        add(field_id, field_id, fields.get(source), None, source_tokens.get(source))
    return dict(version="1.0", profile_id=template["profile_id"],
                coordinate_space="original_percent", fields=observations,
                stage_counts={}, visual_stage_counts={k: v for k, v in visual_counts.items() if k == "injection"})


def build_raw_observations(fields, issues, lines, meta, image_sha256, package):
    """把读值结果包装成 v2 原屏合同；不选模板、不定位、不纠正数值。"""
    definition = package["raw_field_definition"]
    project_boxes(fields, meta)
    for field in fields:
        if field["original_bbox"] is None:
            field["reasons"].append("source_box_unavailable")
    transform = copy.deepcopy(meta)
    transform.update(rectifier_input_sha256=meta.get("original_sha256"), original_sha256=image_sha256)
    return dict(schema_version="page_observations.v2", source="image_recognition", profile_id=PROFILE,
                page_identity=definition["page_identity"], image_sha256=image_sha256,
                original_size=meta.get("original_size"), coordinate_space="original_percent", transform=transform,
                raw_field_definition_sha256=package["raw_field_definition_sha256"],
                raw_field_definition_version=VERSION, raw_contract_sha256=package["raw_contract_sha256"],
                recognizer=package["recognizer"], package_sha256=canonical_hash(package), fields=fields, issues=issues,
                ocr_evidence=dict(coordinate_space="rectified_pixels", screen_size=meta["screen_size"], lines=lines),
                coverage=dict(status="partial", declared=len(fields), known=sum(f["reading"] == "known" for f in fields)))
