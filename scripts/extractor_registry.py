"""Controlled, code-owned extractor IDs. Template data never supplies import paths."""
from importlib import import_module

from contract import _field_catalog


# ID, module, function, input kind, image support, supported pages.
_EXTRACTORS = {
    "arburg.selogica_metering_decimal": ("arburg_decimal", "extract_decimal_selogica", "ocr", False, ("storage_cooling",)),
    "demag.configuration": ("demag_configuration", "extract_configuration", "ocr", False, ("injection_metering",)),
    "arburg.selogica_metering": ("arburg_metering", "extract_selogica", "ocr", False, ("storage_cooling",)),
    "b_and_r.metering": ("b_and_r_metering", "extract_metering", "ocr", False, ("storage_cooling",)),
    "est.storage_white_five_stage": ("est_storage_white", "est_storage_white_extract", "ocr", False, ("storage_cooling",)),
    "zizes.temperature": ("zizes_temperature", "extract_temperature", "tokens", False, ("temperature",)),
    "tact.temperature": ("tact_temperature", "extract_temperature_tact", "tokens", False, ("temperature",)),
    "demag": ("demag", "extract_demag", "tokens", True, ("temperature", "injection_metering")),
    "tact5.process_settings": ("tact5_process", "extract_tact5", "ocr", True, ("process_settings",)),
    "yizumi.injection_holding_f2": ("pages.yizumi_injection_metering_injection_holding_f2", "extract", "ocr", True, ("injection_metering",)),
    "yizumi.metering_f2": ("pages.yizumi_injection_metering_metering_f2", "extract", "ocr", True, ("injection_metering",)),
}
for _family in ("tact", "fanuc", "zizes", "keba", "b_and_r", "kaiming", "est", "trd6", "arburg"):
    _EXTRACTORS[f"{_family}.injection_metering"] = (
        f"{_family}_injection", f"extract_injection_{_family}", "tokens", _family == "b_and_r", ("injection_metering",))
for _family, _module in (("keba", "keba"), ("b_and_r", "b_and_r"), ("fanuc", "fanuc"),
                          ("kaiming", "kaiming_temperature"), ("est", "est_temperature"),
                          ("trd6", "trd6_temperature")):
    _EXTRACTORS[f"{_family}.temperature"] = (
        _module, f"extract_temperature_{_family}", "tokens", False, ("temperature",))
for _page, _function in (("molding_monitor", "extract_molding_monitor_fanuc"),
                         ("waveform", "extract_waveform_fanuc"),
                         ("mold_temp", "extract_mold_temp_fanuc")):
    _EXTRACTORS[f"fanuc.{_page}"] = (f"fanuc_{_page}", _function, "tokens", False, (_page,))
_EXTRACTORS["tact.hot_runner_temp"] = (
    "tact_hot_runner", "extract_hot_runner_tact", "tokens", True, ("hot_runner_temp",))
for _family, _function in (("industrial_chiller", "extract_mold_temp_industrial_chiller"),
                            ("omron_e5cc", "extract_mold_temp_omron_e5cc"),
                            ("mold_thermoregulator", "extract_mold_temp_thermoregulator")):
    _EXTRACTORS[f"{_family}.mold_temp"] = ("mold_temp_devices", _function, "tokens", False, ("mold_temp",))

# Compatibility routes for templates that predate extractor_id. New pages declare
# their extractor_id in the template and never add a branch to extract_page_fields.
_LEGACY_ROUTES = {
    **{("injection_metering", family.upper()): f"{family}.injection_metering"
       for family in ("tact", "fanuc", "zizes", "keba", "b_and_r", "kaiming", "est", "trd6", "arburg")},
    ("injection_metering", "DEMAG"): "demag",
    **{("temperature", family.upper()): f"{family}.temperature"
       for family in ("tact", "keba", "b_and_r", "fanuc", "kaiming", "est", "trd6")},
    ("temperature", "DEMAG"): "demag",
    **{(page, "FANUC"): f"fanuc.{page}" for page in ("molding_monitor", "waveform", "mold_temp")},
    ("hot_runner_temp", "TACT"): "tact.hot_runner_temp",
    **{("mold_temp", family.upper()): f"{family}.mold_temp"
       for family in ("industrial_chiller", "omron_e5cc", "mold_thermoregulator")},
}


def legacy_extractor_id(template: dict) -> str | None:
    """Resolve historical family/page templates through the same controlled registry."""
    if template.get("profile_id") == "tact5.process_settings.injection_holding_metering":
        return "tact5.process_settings"
    page = template.get("page")
    family = template.get("ui_family")
    if page == "injection_metering":
        return _LEGACY_ROUTES.get((page, str(family).upper()))
    return _LEGACY_ROUTES.get((page, family)) or _LEGACY_ROUTES.get(("temperature", family))


def capabilities() -> dict:
    return {
        "version": "1",
        "contract_version": _field_catalog()["contract_version"],
        "routes": ["page_module", "registered_extractor", "generic_fallback"],
        "generic_fallback": {"unknown_only": True, "automatic_apply": False},
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
