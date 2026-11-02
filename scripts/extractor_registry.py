"""Controlled, code-owned extractor IDs. Template data never supplies import paths."""
from importlib import import_module

from contract import _field_catalog
from page_identity import page_identity_match  # Backward-compatible import; routing owns the implementation.


# IDs are code-owned; template data cannot supply Python imports.
_EXTRACTORS = {
    "b_and_r.injection_metering": (
        "b_and_r.injection_holding.extractor",
        "extract_injection_b_and_r", "tokens", True, ("injection_metering",)),
}


def legacy_extractor_id(template: dict) -> str | None:
    """Read historical packages for the one retained page only."""
    if template.get("profile_id") == "b_and_r.injection_holding.multi_stage_position_time":
        return "b_and_r.injection_metering"
    return None


def capabilities() -> dict:
    return {
        "version": "1",
        "contract_version": _field_catalog()["contract_version"],
        "routes": ["registered_extractor"],
        "generic_fallback": {"enabled": False, "automatic_apply": False},
        "extractors": [
            {"extractor_id": key, "extractor_version": "1", "pages": list(value[4]),
             "input": value[2], "image_support": value[3],
             "output": ["fields", "heater_columns", "warnings", "detail"]}
            for key, value in sorted(_EXTRACTORS.items())
        ],
    }


def template_error(template: dict) -> str | None:
    if template.get("enabled", True) is not True:
        return "PAGE_TEMPLATE_DISABLED"
    mode = template.get("extractor")
    if mode not in (None, "page_module", "registered_extractor"):
        return "PAGE_EXTRACTOR_INVALID"
    if "extractor_id" in template or mode == "registered_extractor":
        key = template.get("extractor_id")
        if mode != "registered_extractor" or not isinstance(key, str) or key not in _EXTRACTORS:
            return "EXTRACTOR_ID_UNREGISTERED"
        if template.get("extractor_version", "1") != "1":
            return "EXTRACTOR_VERSION_INCOMPATIBLE"
        if template.get("page") not in _EXTRACTORS[key][4]:
            return "EXTRACTOR_PAGE_INCOMPATIBLE"
    if template.get("contract_version", _field_catalog()["contract_version"]) != _field_catalog()["contract_version"]:
        return "EXTRACTOR_CONTRACT_INCOMPATIBLE"
    return None


def extract_registered(tokens, template, *, ocr_lines=None, meta=None, image_path=None):
    module, function, kind, image_support, _ = _EXTRACTORS[template["extractor_id"]]
    extractor = getattr(import_module("extract_families." + module), function)
    arguments = (ocr_lines or [], template, meta or {}) if kind == "ocr" else (tokens, template)
    return extractor(*arguments, **({"image_path": image_path} if image_support else {}))
