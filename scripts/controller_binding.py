"""Pinned controller bindings select pages only when OCR anchors agree."""
import json
import re
from hashlib import sha256
from pathlib import Path

from extractor_registry import template_error

IDENTITY_KEYS = ("brand", "controller_family", "interface_generation", "page_type", "layout_variant")
BLOCKED_CODES = {
    "PAGE_UNKNOWN", "CONTROLLER_UNKNOWN", "CONTROLLER_HINT_INVALID",
    "CONTROLLER_METADATA_UNVERIFIED", "PAGE_BINDING_MISMATCH",
    "PAGE_TEMPLATE_CONFLICT", "PAGE_TEMPLATE_DISABLED", "PAGE_PACKAGE_INCOMPATIBLE",
}


def content_hash(value):
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def parse_hint(value):
    hint = json.loads(value) if isinstance(value, str) else value
    if not isinstance(hint, dict) or set(hint) != {
            "brand", "controller_family", "interface_generation", "binding_revision", "pages"}:
        raise ValueError("CONTROLLER_HINT_INVALID")
    if (any(not isinstance(hint[key], str) or not 0 < len(hint[key]) <= 100
            for key in ("brand", "controller_family"))
            or hint["interface_generation"] is not None and (
                not isinstance(hint["interface_generation"], str)
                or not 0 < len(hint["interface_generation"]) <= 100)
            or type(hint["binding_revision"]) is not int or hint["binding_revision"] < 1
            or not isinstance(hint["pages"], list) or not 0 < len(hint["pages"]) <= 100):
        raise ValueError("CONTROLLER_HINT_INVALID")
    ids = []
    for page in hint["pages"]:
        if (not isinstance(page, dict) or set(page) != {"profile_id", "version", "package_sha256"}
                or not isinstance(page["profile_id"], str)
                or not re.fullmatch(r"[a-z0-9_]+(?:\.[a-z0-9_]+){2}", page["profile_id"])
                or not isinstance(page["version"], str)
                or not re.fullmatch(r"\d+\.\d+\.\d+", page["version"])
                or not isinstance(page["package_sha256"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", page["package_sha256"])):
            raise ValueError("CONTROLLER_HINT_INVALID")
        ids.append(page["profile_id"])
    if len(ids) != len(set(ids)):
        raise ValueError("CONTROLLER_HINT_INVALID")
    return hint


def validate_identity(template, samples):
    identity = template.get("page_identity")
    if identity is None:
        return
    if (not isinstance(identity, dict) or set(identity) != set(IDENTITY_KEYS) | {"evidence_sample_ids"}
            or any(not isinstance(identity.get(key), str) or not 0 < len(identity[key]) <= 100
                   for key in IDENTITY_KEYS if key != "interface_generation")
            or identity["interface_generation"] is not None and (
                not isinstance(identity["interface_generation"], str)
                or not 0 < len(identity["interface_generation"]) <= 100)
            or identity["page_type"] != template.get("page")
            or identity["layout_variant"] != template.get("layout_variant")
            or not isinstance(identity["evidence_sample_ids"], list)
            or not identity["evidence_sample_ids"]
            or any(not isinstance(item, str) or item not in {
                sample["manifest"]["sample_id"] for sample in samples}
                   for item in identity["evidence_sample_ids"])):
        raise ValueError("Invalid verified page identity or sample references")


def anchors_match(template, lines):
    anchors = template.get("layout_anchors", [])
    return bool(anchors) and all(any(re.fullmatch(anchor, line["text"].strip(), re.I)
                                   for line in lines) for anchor in anchors)


def select_bound_page(hint, lines, image_family, templates_dir, detected_family=None):
    from export_page_package import export_page_package

    root = Path(templates_dir).parent
    registry = json.loads((root / "contracts/profiles.json").read_text())["profiles"]
    active = {}
    for entry in registry:
        if entry.get("template"):
            path = (Path(templates_dir) / entry["template"]).resolve()
            if not path.is_relative_to(Path(templates_dir).resolve()):
                return "unknown", "PAGE_PACKAGE_INCOMPATIBLE", None, {}
            active[entry["profile_id"]] = json.loads(path.read_text())
    receipt = {"binding_revision": hint["binding_revision"], "status": "unknown",
               "image_family": image_family, "template_family_evidence": detected_family}
    bound = []
    for reference in hint["pages"]:
        pid = reference["profile_id"]
        if pid not in active:
            return "unknown", "CONTROLLER_UNKNOWN", None, receipt
        try:
            package = export_page_package(pid, reference["version"], root)
        except (OSError, ValueError, KeyError, StopIteration):
            return "unknown", "PAGE_PACKAGE_INCOMPATIBLE", None, receipt
        template = package.get("template")
        if not template or content_hash(package) != reference["package_sha256"]:
            return "unknown", "PAGE_PACKAGE_INCOMPATIBLE", None, receipt
        identity = template.get("page_identity")
        try:
            validate_identity(template, package["samples"])
        except (ValueError, KeyError, TypeError):
            return "unknown", "PAGE_PACKAGE_INCOMPATIBLE", None, receipt
        if not identity:
            return "unknown", "CONTROLLER_METADATA_UNVERIFIED", None, receipt
        if any(identity[key] != hint[key] for key in
               ("brand", "controller_family", "interface_generation")):
            return "unknown", "PAGE_BINDING_MISMATCH", None, receipt
        bound.append((reference, template))
    matches = [(reference, template) for reference, template in bound if anchors_match(template, lines)]
    if any(family not in ("unknown", "", None)
           and family not in template.get("route_families", [template.get("ui_family")])
           for family in (image_family, detected_family) for _, template in bound):
        return "unknown", "PAGE_BINDING_MISMATCH", None, receipt
    bound_ids = {reference["profile_id"] for reference, _ in bound}
    opposing = [template for pid, template in active.items()
                if pid not in bound_ids and anchors_match(template, lines)]
    if len(matches) > 1 or matches and opposing:
        return "unknown", "PAGE_TEMPLATE_CONFLICT", None, receipt
    if not matches:
        return "unknown", "PAGE_BINDING_MISMATCH" if opposing else "PAGE_UNKNOWN", None, receipt
    reference, template = matches[0]
    if active[reference["profile_id"]].get("enabled", True) is not True:
        return template["page"], "PAGE_TEMPLATE_DISABLED", None, receipt
    error = template_error(template)
    if error:
        return template["page"], error, None, receipt
    receipt.update(status="compatible", code="PAGE_COMPATIBLE", selection="ocr_anchors_and_pinned_binding",
                   **reference, page_identity=template["page_identity"],
                   profile_status=next(item.get("status", "candidate") for item in registry
                                       if item["profile_id"] == reference["profile_id"]))
    return template["page"], "controller_binding", template, receipt
