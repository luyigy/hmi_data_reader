"""B&R 射胶保压页的固定版本包、字段定义与源码完整性。此文件不读图。"""

# 发布配套：固定页面定义、版本、源码清单及哈希。它是交付材料管理，不属于识图算法。
# 已发布旧版本仅作为历史文档导出；当前运行版本检查当前源码，不原地改写旧包。

import hashlib
import json
from pathlib import Path
from raw_contract import canonical_hash, import_raw_package

ROOT = Path(__file__).resolve().parents[4]
PROFILE = "b_and_r.injection_holding.multi_stage_position_time"
VERSION = "0.6.2"
DEFINITION = "contracts/raw-pages/b-and-r-injection-0.6.2.json"
PAGE_DIR = "scripts/extract_families/b_and_r/injection_holding"
FILES = tuple(f"{PAGE_DIR}/{name}.py" for name in (
    "package", "page_identity", "layout", "extractor", "observations")) + (
    "scripts/raw_contract.py", "scripts/raw_page.py", "scripts/extract_families/coordinates.py",
    "scripts/extract_families/common.py", "scripts/extract_families/visual_cells.py", DEFINITION)

def build_bole_injection_package(samples):
    definition = json.loads((ROOT / DEFINITION).read_text())
    expected = {sample["sample_id"]: sample["image_sha256"] for sample in definition["samples"]}
    provided = {sample["manifest"]["sample_id"]: sample["manifest"]["original_sha256"] for sample in samples}
    if provided != expected or len(samples) != len(expected) or len(set(provided.values())) != len(expected):
        raise ValueError("BOLE_INJECTION_FROZEN_SAMPLES_REQUIRED")
    template = json.loads((ROOT / "templates/b_and_r/injection_holding.json").read_text())
    template.update(version=VERSION, extractor="registered_extractor",
                    extractor_id="b_and_r.injection_metering", extractor_version="1",
                    layout_variant=definition["page_identity"]["layout_variant"],
                    page_identity={**definition["page_identity"],
                                   "evidence_sample_ids": [s["sample_id"] for s in definition["samples"]]},
                    sample_ids=[s["sample_id"] for s in definition["samples"]])
    contract = json.loads((ROOT / "contracts/page_observations.v2.schema.json").read_text())
    sources = {path: (ROOT / path).read_text() for path in FILES}
    files = {path: hashlib.sha256(source.encode()).hexdigest() for path, source in sources.items()}
    return dict(package_schema="hmi_raw_page_package.v2", profile_id=PROFILE, version=VERSION,
                template=template, raw_contract=contract, raw_contract_sha256=canonical_hash(contract),
                raw_field_definition=definition, raw_field_definition_sha256=canonical_hash(definition),
                recognizer=dict(id="b_and_r.injection_ocr.v2", version=VERSION, files=files,
                                sources=sources, sha256=canonical_hash(files)), samples=samples)

def bole_injection_package(root=ROOT, version=VERSION):
    package = import_raw_package(json.loads((Path(root) / "templates/raw-packages" / PROFILE / f"{version}.json").read_text()))
    if package["profile_id"] != PROFILE or package["version"] != version:
        raise ValueError("RAW_PACKAGE_IDENTITY_MISMATCH")
    if version != VERSION:
        # Historical document export only. Live observations use VERSION and verify live sources.
        return package
    if package["raw_field_definition"] != json.loads((ROOT / DEFINITION).read_text()):
        raise ValueError("RAW_DEFINITION_MISMATCH")
    recognizer = package["recognizer"]
    files = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in FILES}
    if (recognizer.get("id") != "b_and_r.injection_ocr.v2" or recognizer["files"] != files
            or recognizer["sha256"] != canonical_hash(files)
            or {path: hashlib.sha256(source.encode()).hexdigest()
                for path, source in recognizer["sources"].items()} != files):
        raise ValueError("RAW_RECOGNIZER_HASH_MISMATCH")
    return package
