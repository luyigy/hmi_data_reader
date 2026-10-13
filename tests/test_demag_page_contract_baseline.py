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


@pytest.mark.parametrize("fixture", [
    "demag_holding_z002_ocr.json",
    "demag_injection_z002_wehdt_ocr.json",
    "demag_metering_z002_ocr.json",
])
def test_http_cli_and_feishu_use_the_same_demag_observations(fixture, tmp_path, monkeypatch):
    import asyncio
    import io
    import sys

    sys.path.insert(0, str(ROOT / "scripts"))
    import cv2
    import numpy as np
    from fastapi import UploadFile
    from quality import QualityReport

    import extract_fields
    import feishu_card_assistant as card
    import hmi_service as service

    ocr = json.loads((ROOT / "tests/fixtures" / fixture).read_text())
    width, height = ocr["screen_size"]
    lines = [dict(text=line["text"], conf=line["confidence"],
                  bbox=dict(zip(("x_min", "y_min", "x_max", "y_max"), line["bbox"])))
             for line in ocr["lines"]]
    image = np.full((height, width, 3), 255, dtype=np.uint8)
    meta = dict(ok=True, screen_size=[width, height], original_size=[width, height],
                screen_quad=[[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])

    def rectify(_source, target, metadata=None, max_size=None):
        cv2.imwrite(str(target), image)
        if metadata:
            Path(metadata).write_text(json.dumps(meta))
        return meta

    class OCR:
        def ocr(self, *args, **kwargs):
            return [[[[[line["bbox"]["x_min"], line["bbox"]["y_min"]],
                      [line["bbox"]["x_max"], line["bbox"]["y_min"]],
                      [line["bbox"]["x_max"], line["bbox"]["y_max"]],
                      [line["bbox"]["x_min"], line["bbox"]["y_max"]]],
                     (line["text"], line["conf"])] for line in lines]]

    monkeypatch.setattr(service, "is_ready", True)
    monkeypatch.setattr(service, "ocr_model", OCR())
    monkeypatch.setattr(service, "assess", lambda *args: QualityReport(filename="fixture", triage="green"))
    monkeypatch.setattr(service, "rectify", rectify)
    monkeypatch.setattr(service, "postprocess_one", lambda *args: {})
    monkeypatch.setattr(service, "classify", lambda *args: dict(ui_family="DEMAG", page="injection_metering"))
    monkeypatch.setattr(card, "assess", service.assess)
    monkeypatch.setattr(card, "rectify", rectify)
    monkeypatch.setattr(card, "run_ocr_for_image", lambda *args: lines)
    monkeypatch.setattr(card, "TEMPLATES_DIR", ROOT / "templates")

    source = tmp_path / "demag.png"
    cv2.imwrite(str(source), image)
    feishu = card.process_hmi_image(source, tmp_path / "card")
    cli = extract_fields.extract_one(source.stem, tmp_path / "card/rectified", None, None, ROOT / "templates")
    _, encoded = cv2.imencode(".png", image)

    async def run_http():
        monkeypatch.setattr(service, "concurrency_semaphore", asyncio.Semaphore(1))
        upload = UploadFile(file=io.BytesIO(encoded.tobytes()), filename="demag.png")
        return await service.recognize_image(upload, include_review_image=False)

    http = asyncio.run(run_http())
    assert "page_observations" in feishu, (feishu.get("status"), feishu.get("warnings"), feishu.get("profile_id"))
    cli_observations = cli.get("extraction_detail", {}).get("page_observations")
    assert cli_observations, (cli.get("status"), cli.get("warnings"), cli.get("profile_id"))
    assert "page_observations" in http, (http.get("status"), http.get("warnings"), http.get("profile_id"))
    assert feishu["page_observations"] == cli_observations
    # HTTP projects original-image boxes after shared extraction; compare the shared facts.
    http_observations = json.loads(json.dumps(http["page_observations"]))
    for field in http_observations["fields"]:
        field["original_bbox"] = None
    assert cli_observations == http_observations
    assert feishu["profile_id"] == cli["profile_id"] == http["profile_id"]
