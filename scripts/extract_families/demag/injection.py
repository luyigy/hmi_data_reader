"""DEMAG page extraction entry point; physical page rules live beside it."""

from .curve import (DARK_CELL_RATIO, _extract_curve, _extract_global_pressure,
                    _is_curve, _ocr_conflict_code, _stage_enabled)
from .metering import metering_page_observations
from .observations import holding_observations, injection_observations
from .optimization import _extract_optim


def extract_injection_demag(toks: list[dict], template: dict, image_path=None) -> dict:
    # image_path：矫正后 PNG（可选）。传入时对段表做 Layer 1 禁用段图像观测，
    # 结果放 detail["stage_enabled"]；缺省 None 时完全保持现行为（无观测输出）。
    img = None
    if image_path is not None:
        import cv2  # 延迟导入：无图像流程不引入 cv2
        img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    warnings: list[str] = []
    stage_enabled = None
    pressure_unit_text = None
    if _is_curve(toks):
        fields = _extract_curve(toks, template["curve_page"], warnings, img=img)
        variant = fields.pop("_page_variant", "multi_stage_injection")
        stage_enabled = fields.pop("_stage_enabled", None)
        pressure_unit_text = fields.pop("_pressure_unit_text", None)
    else:
        fields = _extract_optim(toks, template, warnings)
        variant = "process_optimization"
        # 降级/回退策略：若工艺优化页大部分字段缺失（缺失率 >= 80%），自动尝试曲线页抽取
        missing_count = sum(1 for v in fields.values() if v is None)
        if missing_count >= len(fields) * 0.8 and "curve_page" in template:
            curve_warnings: list[str] = []
            curve_fields = _extract_curve(toks, template["curve_page"], curve_warnings, img=img)
            if any(v is not None for v in curve_fields.values()):
                fields = curve_fields
                warnings = curve_warnings
                variant = fields.pop("_page_variant", "multi_stage_injection")
                stage_enabled = fields.pop("_stage_enabled", None)
                pressure_unit_text = fields.pop("_pressure_unit_text", None)

    detail = {"page_variant": variant}
    if variant in ("multi_stage_injection", "multi_stage_holding"):
        detail["pressure_unit_text"] = pressure_unit_text
    if variant == "multi_stage_holding":
        detail["page_observations"] = holding_observations(fields)
    elif variant == "multi_stage_injection":
        detail["page_observations"] = injection_observations(fields)
    elif variant == "multi_stage_back_pressure":
        detail["page_observations"] = metering_page_observations(fields, toks, img, _stage_enabled)
    if stage_enabled:
        detail["stage_enabled"] = stage_enabled
    return {"fields": fields, "heater_columns": 0,
            "warnings": warnings, "detail": detail}

