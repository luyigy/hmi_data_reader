"""Frozen SELOGICA observations with no process-data projection."""

import copy
import hashlib
import json
import re
from pathlib import Path

from raw_contract import canonical_hash, import_raw_package
from extract_families.arburg_metering import PROFILE, DEFINITION, extract_selogica

ROOT = Path(__file__).resolve().parents[1]
FILES = ("scripts/raw_arburg.py", "scripts/extract_families/arburg_metering.py",
         "scripts/raw_contract.py", "scripts/raw_page.py", "scripts/extract_families/coordinates.py",
         "scripts/quality.py", "contracts/raw-pages/arburg-selogica-metering-1.0.0.json")


def build_selogica_package(template, samples):
    definition = json.loads(DEFINITION.read_text())
    expected = {sample["sample_id"]: sample["image_sha256"] for sample in definition["samples"]}
    provided = {sample["manifest"]["sample_id"]: sample["manifest"]["original_sha256"] for sample in samples}
    if provided != expected or len(samples) != len(expected) or len(set(provided.values())) != len(expected):
        raise ValueError("SELOGICA_FROZEN_SAMPLES_REQUIRED")
    if (template.get("profile_id") != PROFILE or template.get("extractor_id") != "arburg.selogica_metering"
            or any(template.get("page_identity", {}).get(key) != value for key, value in definition["page_identity"].items())):
        raise ValueError("SELOGICA_CONTROLLER_IDENTITY_CONFLICT")
    definition["version"] = template["version"]
    contract = json.loads((ROOT / "contracts/page_observations.v2.schema.json").read_text())
    sources = {path: (ROOT / path).read_text() for path in FILES}
    files = {path: hashlib.sha256(source.encode()).hexdigest() for path, source in sources.items()}
    return dict(package_schema="hmi_raw_page_package.v2", profile_id=PROFILE, version=template["version"],
                template=template, samples=samples, raw_contract=contract, raw_contract_sha256=canonical_hash(contract),
                raw_field_definition=definition, raw_field_definition_sha256=canonical_hash(definition),
                recognizer=dict(id="arburg.selogica_metering.v2", version="1.0.0", files=files,
                                sources=sources, sha256=canonical_hash(files)))


def observe_selogica(lines, meta, image_sha256, root=ROOT, version="1.0.0"):
    if not re.fullmatch(r"[a-f0-9]{64}", image_sha256):
        raise ValueError("IMAGE_HASH_INVALID")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("RAW_PAGE_VERSION_UNSUPPORTED")
    package = import_raw_package(json.loads((Path(root) / "templates/packages" / PROFILE / f"{version}.json").read_text()))
    if package["profile_id"] != PROFILE or package["version"] != version:
        raise ValueError("RAW_PACKAGE_IDENTITY_MISMATCH")
    recognizer = package["recognizer"]
    actual = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in FILES}
    embedded = {path: hashlib.sha256(source.encode()).hexdigest() for path, source in recognizer.get("sources", {}).items()}
    if (recognizer.get("id") != "arburg.selogica_metering.v2" or actual != recognizer.get("files")
            or actual != embedded or canonical_hash(actual) != recognizer["sha256"]):
        raise ValueError("RAW_RECOGNIZER_HASH_MISMATCH")
    result = extract_selogica(lines, package["template"], meta)
    if not result["detail"]:
        raise ValueError(result["warnings"][0])
    observation = result["detail"]["page_observations"]
    for field in observation["fields"]:
        field["template_ref"] = dict(profile_id=PROFILE, version=version,
                                     sha256=package["raw_field_definition_sha256"],
                                     unit=field["effective_unit"] if field["original_unit"] is None else None)
    transform = copy.deepcopy(meta)
    transform.update(rectifier_input_sha256=meta.get("original_sha256"), original_sha256=image_sha256)
    observation.update(schema_version="page_observations.v2", source="image_recognition", image_sha256=image_sha256,
                       page_identity=package["raw_field_definition"]["page_identity"], original_size=meta.get("original_size"),
                       coordinate_space="original_percent", transform=transform,
                       raw_contract_sha256=package["raw_contract_sha256"],
                       raw_field_definition_sha256=package["raw_field_definition_sha256"], raw_field_definition_version=version,
                       recognizer=recognizer, package_sha256=canonical_hash(package),
                       ocr_evidence=dict(coordinate_space="rectified_pixels", screen_size=meta["screen_size"], lines=lines))
    return observation
