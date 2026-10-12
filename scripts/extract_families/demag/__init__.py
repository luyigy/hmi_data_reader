"""DEMAG controller family extraction entry point."""

from .injection import extract_injection_demag
from .temperature import extract_temperature_demag


def extract_demag(toks: list[dict], template: dict, image_path=None) -> dict:
    page = template.get("page")
    if page == "temperature":
        return extract_temperature_demag(toks, template)
    if page == "injection_metering":
        return extract_injection_demag(toks, template, image_path=image_path)
    raise ValueError(f"Unsupported DEMAG page: {page}")
