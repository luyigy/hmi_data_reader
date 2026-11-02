"""Shared page selection for CLI, HTTP and Feishu extraction."""
import json
import re
from pathlib import Path
from extractor_registry import template_error
from page_identity import PLUGINS, page_identity_match, profile_identity

TEMPLATES_DIR = Path("templates")
BLOCKED_PAGE_SOURCES = {
    "disabled_template": "PAGE_TEMPLATE_DISABLED",
    "ambiguous_template_anchors": "PAGE_TEMPLATE_CONFLICT",
    "PAGE_TEMPLATE_DISABLED": "PAGE_TEMPLATE_DISABLED",
    "PAGE_EXTRACTOR_INVALID": "PAGE_EXTRACTOR_INVALID",
    "EXTRACTOR_ID_UNREGISTERED": "EXTRACTOR_ID_UNREGISTERED",
    "EXTRACTOR_VERSION_INCOMPATIBLE": "EXTRACTOR_VERSION_INCOMPATIBLE",
    "EXTRACTOR_PAGE_INCOMPATIBLE": "EXTRACTOR_PAGE_INCOMPATIBLE",
    "EXTRACTOR_CONTRACT_INCOMPATIBLE": "EXTRACTOR_CONTRACT_INCOMPATIBLE",
}
from controller_binding import BLOCKED_CODES
BLOCKED_PAGE_SOURCES.update({code: code for code in BLOCKED_CODES})

def registered_page_templates(family: str, templates_dir: Path,
                              page: str | None = None,
                              lines: list[dict] | None = None,
                              include_disabled: bool = False) -> list[dict]:
    registry = templates_dir.parent / "contracts" / "profiles.json"
    if not registry.is_file():
        return []
    texts = [line["text"].strip() for line in lines] if lines is not None else None
    matches = []
    for profile in json.loads(registry.read_text()).get("profiles", []):
        if profile["profile_id"] not in PLUGINS:
            continue
        filename = profile.get("template")
        if not filename:
            continue
        path = templates_dir / filename
        template = json.loads(path.read_text())
        if template.get("profile_id") != profile["profile_id"]:
            raise ValueError(f"Registered template identity mismatch: {path}")
        if not include_disabled and template.get("enabled", True) is not True:
            continue
        if page is not None and template.get("page") != page:
            continue
        assessment = profile_identity(template.get('profile_id'), lines, family) if lines is not None else None
        if assessment is not None:
            if assessment['matched'] and not assessment['conflicts']:
                matches.append(template)
            # Plugin decisions are final for this profile, including unknown.
            continue
        identity_match = None
        if family not in template.get("route_families", [template.get("ui_family")]):
            if family != 'unknown' or lines is None:
                continue
            identity_match = page_identity_match(template, lines)
            if not identity_match:
                continue
        if texts is not None:
            anchors = template.get("layout_anchors", [])
            if not anchors or not all(any(re.fullmatch(anchor, text, re.I) for text in texts) for anchor in anchors):
                if identity_match is None:
                    identity_match = page_identity_match(template, lines)
                if not identity_match:
                    continue
        matches.append(template)
    return matches

def route_page(stem, lines, family, templates_dir=TEMPLATES_DIR, extra_anchor_lines=None):
    """Only registered structural identities select a page; filenames never route."""
    candidates = registered_page_templates(family, templates_dir, lines=lines, include_disabled=True)
    if any(t.get('enabled', True) is not True for t in candidates):
        return 'unknown', 'disabled_template'
    if len(candidates) > 1:
        return 'unknown', 'ambiguous_template_anchors'
    return (candidates[0]['page'], 'template_anchors') if candidates else ('unknown', 'none')


def load_template(family, page, templates_dir=TEMPLATES_DIR, lines=None):
    candidates = registered_page_templates(family, templates_dir, page=page, lines=lines)
    return candidates[0] if len(candidates) == 1 else None


def resolve_page_template(stem, lines, family, templates_dir=TEMPLATES_DIR, extra_anchor_lines=None):
    page, source = route_page(stem, lines, family, templates_dir)
    if source in BLOCKED_PAGE_SOURCES:
        return page, source, None
    template = load_template(family, page, templates_dir, lines=lines)
    if template is not None:
        error = template_error(template)
        if error:
            return page, error, None
    return page, source, template
