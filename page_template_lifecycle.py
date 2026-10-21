"""Drafts are isolated; the registry pointer is the publication commit point."""
import fcntl
import json
import re
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path

from fastapi import HTTPException

from page_template_store import atomic_json
from scripts.export_page_package import export_page_package
from scripts.extract_fields import extract_page_fields, norm_tokens
from scripts.extractor_registry import capabilities, template_error

PROFILE = re.compile(r"[a-z0-9_]+(?:\.[a-z0-9_]+){2}")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def _draft_path(root, profile_id):
    if not PROFILE.fullmatch(profile_id):
        raise HTTPException(422, "Invalid profile_id")
    return root / "templates/drafts" / f"{profile_id}.json"


@contextmanager
def _locked(root):
    directory = root / "templates"
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".page-template.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def _registry(root):
    return json.loads((root / "contracts/profiles.json").read_text())


def _current(root, profile_id):
    entry = next((p for p in _registry(root)["profiles"] if p["profile_id"] == profile_id), None)
    if not entry or not entry.get("template"):
        return None
    path = (root / "templates" / entry["template"]).resolve()
    if not path.is_relative_to((root / "templates").resolve()):
        raise HTTPException(409, "Invalid active template path")
    return json.loads(path.read_text())


def _check_base(current, expected_version):
    if (current["version"] if current else None) != expected_version:
        raise HTTPException(409, "Active version changed")


def _validate(profile_id, template, samples):
    from scripts.controller_binding import validate_identity
    try:
        validate_identity(template, samples)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from None
    if template.get("profile_id") != profile_id or not VERSION.fullmatch(str(template.get("version", ""))):
        raise HTTPException(422, "Invalid template identity or version")
    if template.get("extractor") != "registered_extractor":
        raise HTTPException(422, "New drafts require registered_extractor and a catalog extractor_id")
    if any(key in template for key in ("module", "function", "import_path", "extractor_module", "extractor_function")):
        raise HTTPException(422, "Import paths are not template configuration")
    if type(template.get("enabled", True)) is not bool:
        raise HTTPException(422, "Invalid enabled state")
    error = template_error({**template, "enabled": True})
    if error:
        raise HTTPException(422, error)
    families = template.get("route_families", [template.get("ui_family")])
    anchors = template.get("layout_anchors")
    if (not isinstance(families, list) or not families
            or not all(isinstance(f, str) and f for f in families)
            or not isinstance(template.get("ui_family"), str)
            or not isinstance(template.get("business_profile_candidate"), dict)
            or not isinstance(anchors, list) or not anchors
            or not all(isinstance(a, str) and 0 < len(a) <= 100 for a in anchors)):
        raise HTTPException(422, "Routing anchors, families and business candidate are required")
    try:
        for anchor in anchors:
            re.compile(anchor)
        ids = []
        for sample in samples:
            manifest, ocr = sample["manifest"], sample["ocr"]
            sample_id = manifest["sample_id"]
            if not isinstance(sample_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", sample_id):
                raise ValueError("Invalid sample ID")
            if manifest["profile_id"] != profile_id:
                raise ValueError("Sample profile mismatch")
            size = manifest.get("screen_size", manifest.get("original_size"))
            if (not isinstance(size, list) or len(size) != 2
                    or any(type(v) is not int or v <= 0 for v in size)
                    or not re.fullmatch(r"[a-f0-9]{64}", manifest.get("original_sha256", ""))
                    or not isinstance(ocr["lines"], list) or not ocr["lines"]):
                raise ValueError("Sample needs image identity, dimensions and OCR lines")
            ids.append(sample_id)
        if not ids or len(ids) != len(set(ids)) or template.get("sample_ids") != ids:
            raise ValueError("Template sample_ids must match the frozen samples")
    except (KeyError, TypeError, ValueError, re.error) as exc:
        raise HTTPException(422, f"Invalid draft evidence: {exc}") from None


def read_draft(root: Path, profile_id: str) -> dict:
    path = _draft_path(root, profile_id)
    if not path.is_file():
        raise HTTPException(404, "Draft does not exist")
    return json.loads(path.read_text())


def save_draft(root: Path, profile_id: str, template: dict, samples: list,
               expected_version: str | None, expected_revision: int | None = None) -> dict:
    path = _draft_path(root, profile_id)
    template = {"extractor_version": "1", "contract_version": capabilities()["contract_version"], **template}
    if len(json.dumps({"template": template, "samples": samples})) > 2_000_000:
        raise HTTPException(413, "Draft too large")
    _validate(profile_id, template, samples)
    with _locked(root):
        _check_base(_current(root, profile_id), expected_version)
        previous = read_draft(root, profile_id) if path.exists() else None
        if (previous["revision"] if previous else None) != expected_revision:
            raise HTTPException(409, "Draft revision changed")
        result = {"profile_id": profile_id, "revision": (expected_revision or 0) + 1,
                  "base_version": expected_version, "template": template, "samples": samples}
        atomic_json(path, result)
        return result


def _extract(template, samples):
    results = []
    try:
        for sample in samples:
            manifest, ocr = sample["manifest"], sample["ocr"]
            size = manifest.get("screen_size", manifest.get("original_size"))
            lines = []
            for line in ocr["lines"]:
                box = line["bbox"]
                lines.append({**line, "conf": line.get("conf", line.get("confidence")),
                              "bbox": dict(zip(("x_min", "y_min", "x_max", "y_max"), box))
                              if isinstance(box, list) else box})
            result = extract_page_fields(norm_tokens({"lines": lines}, size),
                                         {**template, "enabled": True}, ocr_lines=lines,
                                         meta={"screen_size": size})
            if not result.get("fields") and not result.get("detail", {}).get("page_observations", {}).get("fields"):
                raise ValueError(f"No observations: {result.get('warnings')}")
            results.append({"sample_id": manifest["sample_id"], "result": result})
    except (KeyError, TypeError, ValueError, IndexError, ImportError) as exc:
        raise HTTPException(422, f"Trial failed: {exc}") from None
    return results


def trial_draft(root: Path, profile_id: str, expected_revision: int) -> dict:
    draft = read_draft(root, profile_id)
    if draft["revision"] != expected_revision:
        raise HTTPException(409, "Draft revision changed")
    current = _current(root, profile_id)
    _check_base(current, draft["base_version"])
    _validate(profile_id, draft["template"], draft["samples"])
    after = _extract(draft["template"], draft["samples"])
    before = _extract(current, draft["samples"]) if current else []
    return {"profile_id": profile_id, "revision": expected_revision,
            "base_version": draft["base_version"], "before": before, "after": after,
            "changed": before != after}


def _freeze(path, value):
    if path.exists():
        if json.loads(path.read_text()) != value:
            raise HTTPException(409, "Published version already exists with different content")
    else:
        atomic_json(path, value)


def publish_draft(root: Path, profile_id: str, expected_revision: int,
                  expected_version: str | None, confirmation: str) -> dict:
    if confirmation != "publish_confirmed":
        raise HTTPException(422, "Publication requires confirmation")
    _draft_path(root, profile_id)
    with _locked(root):
        current = _current(root, profile_id)
        _check_base(current, expected_version)
        draft = read_draft(root, profile_id)
        if draft["base_version"] != expected_version or draft["revision"] != expected_revision:
            raise HTTPException(409, "Draft revision or base changed")
        template = {**draft["template"], "require_anchor_match": True}
        _validate(profile_id, template, draft["samples"])
        version = template["version"]
        if current and tuple(map(int, version.split("."))) <= tuple(map(int, current["version"].split("."))):
            raise HTTPException(409, "Publication needs a new, increasing version")
        if current:
            before_parts = tuple(map(int, current["version"].split(".")))
            after_parts = tuple(map(int, version.split(".")))
            if before_parts[:2] == after_parts[:2] and after_parts[2] != before_parts[2] + 1:
                raise HTTPException(409, "Patch versions must be consecutive")
        trial = trial_draft(root, profile_id, expected_revision)
        if any(row["result"].get("detail", {}).get("page_observations", {}).get("publication_state")
               == "development_only" for row in trial["after"]):
            raise HTTPException(422, "EXTRACTOR_DEVELOPMENT_ONLY: independent acceptance and raw package are pending")
        samples = []
        for sample in draft["samples"]:
            digest = sha256(json.dumps(sample["ocr"], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            samples.append({**sample, "ocr_content_sha256": digest})
        package = {"package_schema": "hmi_page_package.v1", "profile_id": profile_id,
                   "version": version, "template": template, "samples": samples}
        if template.get("extractor_id") == "arburg.selogica_metering_decimal":
            from scripts.raw_arburg_decimal import build_decimal_package
            try:
                package = build_decimal_package(template, samples)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
        if template.get("extractor_id") == "arburg.selogica_metering":
            from scripts.raw_arburg import build_selogica_package
            try:
                package = build_selogica_package(template, samples)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
        if template.get("extractor_id") == "b_and_r.metering":
            from scripts.raw_metering import build_metering_package
            try:
                package = build_metering_package(template, samples)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
        if template.get("extractor_id") == "demag.configuration":
            from scripts.raw_demag_configuration import build_configuration_package
            try:
                package = build_configuration_package(template, samples)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
        relative = f"published/{profile_id}/{version}.json"
        try:
            if current:
                old_version = current["version"]
                old_package = export_page_package(profile_id, old_version, root)
                _freeze(root / "templates/versions" / profile_id / f"{old_version}.json", current)
                _freeze(root / "templates/packages" / profile_id / f"{old_version}.json", old_package)
            _freeze(root / "templates" / relative, template)
            _freeze(root / "templates/packages" / profile_id / f"{version}.json", package)
            registry = _registry(root)
            entry = next((p for p in registry["profiles"] if p["profile_id"] == profile_id), None)
            if entry is None:
                entry = {"profile_id": profile_id, "status": "candidate"}
                registry["profiles"].append(entry)
            entry.update(template=relative, controller_family=template["ui_family"],
                         page_type=template["page"], layout_variant=template.get("layout_variant", ""))
            if template.get("page_identity"):
                entry["page_identity"] = template["page_identity"]
            atomic_json(root / "contracts/profiles.json", registry)
        except OSError as exc:
            raise HTTPException(503, f"Publication storage failed: {exc}") from None
    return {"profile_id": profile_id, "version": version, "enabled": template.get("enabled", True),
            "revision": expected_revision, "trial": trial}
