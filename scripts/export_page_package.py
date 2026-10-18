"""Export a pinned Reader page package for review by the main repository."""
import argparse
import json
import re
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def export_page_package(profile_id: str, version: str, root: Path = ROOT) -> dict:
    if version in ("0.4.0", "0.4.1"):
        try:
            from raw_temperature_time import DEFINITIONS, temperature_time_package
        except ModuleNotFoundError:
            from scripts.raw_temperature_time import DEFINITIONS, temperature_time_package
        if profile_id in DEFINITIONS:
            return temperature_time_package(profile_id, version, root)
    if version == "0.3.0" and profile_id == "demag.injection_metering.multi_stage_holding":
        try:
            from raw_page import raw_page_package
        except ModuleNotFoundError:
            from scripts.raw_page import raw_page_package
        return raw_page_package(profile_id, version, root)
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError(f"Invalid page version: {version}")
    registry = json.loads((root / "contracts/profiles.json").read_text())
    registered = next((p for p in registry["profiles"]
                       if p["profile_id"] == profile_id), None)
    if not registered or not registered.get("template"):
        raise ValueError(f"Unregistered page template: {profile_id}")
    if not re.fullmatch(r"[a-z0-9_]+(?:\.[a-z0-9_]+){2}", profile_id):
        raise ValueError("Invalid profile ID")
    active = root / "templates" / registered["template"]
    current = json.loads(active.read_text())
    archive = root / "templates/versions" / profile_id / f"{version}.json"
    frozen = root / "templates/packages" / profile_id / f"{version}.json"
    if frozen.is_file() and (current["version"] == version or archive.is_file()):
        package = json.loads(frozen.read_text())
        if (package.get("profile_id") != profile_id or package.get("version") != version
                or package["template"].get("profile_id") != profile_id
                or package["template"].get("version") != version):
            raise ValueError("Frozen package identity mismatch")
        return package
    if current["version"] == version:
        path = active
    else:
        path = root / "templates/versions" / profile_id / f"{version}.json"
    template = json.loads(path.read_text())
    if template.get("profile_id") != profile_id or template.get("version") != version:
        raise ValueError(f"Page package identity or version mismatch: {path}")
    samples = []
    for sample_id in template.get("sample_ids", []):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", sample_id):
            raise ValueError(f"Invalid sample ID: {sample_id}")
        manifest_path = root / "templates/samples" / profile_id / f"{sample_id}.json"
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("profile_id") != profile_id or manifest.get("sample_id") != sample_id:
            raise ValueError(f"Sample identity mismatch: {manifest_path}")
        fixture_path = (root / manifest["ocr_fixture"]).resolve()
        if not fixture_path.is_relative_to((root / "tests/fixtures").resolve()):
            raise ValueError(f"OCR fixture outside tests/fixtures: {fixture_path}")
        fixture_bytes = fixture_path.read_bytes()
        if sha256(fixture_bytes).hexdigest() != manifest["ocr_sha256"]:
            raise ValueError(f"OCR fixture hash mismatch: {fixture_path}")
        samples.append({"manifest": manifest, "ocr": json.loads(fixture_bytes)})
    return {"package_schema": "hmi_page_package.v1", "profile_id": profile_id,
            "version": version, "template": template, "samples": samples}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile_id")
    parser.add_argument("version")
    args = parser.parse_args()
    print(json.dumps(export_page_package(args.profile_id, args.version),
                     ensure_ascii=False, sort_keys=True))
