"""Full fixed OCR outputs for the three DEMAG physical pages."""

import hashlib
import json
from pathlib import Path

import pytest

from scripts.export_page_package import export_page_package
from scripts.extract_families.demag import extract_demag


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("fixture,profile_id,version,expected_sha256", [
    ("demag_holding_z002_ocr.json", "demag.injection_metering.multi_stage_holding", "0.2.1",
     "eddc3f3f5efa4b466ad7432d1850e8054612d5eda7a8a65e5740100c1b3d1750"),
    ("demag_injection_z002_wehdt_ocr.json", "demag.injection_metering.multi_stage_injection", "0.1.0",
     "4428156723767e82c0d8b562cb0bdc398cc655a3c92465bf60dc885cd9e373d5"),
    ("demag_metering_z002_ocr.json", "demag.injection_metering.multi_stage_back_pressure", "0.2.1",
     "3e3bbcaaded6356b466863a03a6e1dc8a3e8a19857c114e77c4e952876bfa136"),
    ("demag_metering_z005_ocr.json", "demag.injection_metering.multi_stage_back_pressure", "0.2.1",
     "421da2a8f3716d0aa89ae169e09a77b1e2a378adb4d62684630009d780f27f46"),
])
def test_page_output_remains_byte_equivalent(fixture, profile_id, version, expected_sha256):
    ocr = json.loads((ROOT / "tests/fixtures" / fixture).read_text())
    width, height = ocr["screen_size"]
    tokens = [dict(text=line["text"],
                   x=(line["bbox"][0] + line["bbox"][2]) / (2 * width),
                   y=(line["bbox"][1] + line["bbox"][3]) / (2 * height))
              for line in ocr["lines"]]
    package = export_page_package(profile_id, version)
    result = extract_demag(tokens, package["template"])
    content = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    assert hashlib.sha256(content).hexdigest() == expected_sha256
