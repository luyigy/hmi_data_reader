"""Review image must be captured from the selected OCR attempt, before rescue overwrites files."""
import asyncio
import base64
import io
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import UploadFile
import hmi_service as svc
from quality import QualityReport


def test_review_image_uses_selected_attempt():
    calls = []
    def rectify(original, target, meta, max_size=None):
        calls.append(max_size)
        image = np.full((60, 80, 3), 50 if len(calls) == 1 else 200, dtype=np.uint8)
        cv2.imwrite(str(target), image)
        return {"ok": True, "screen_size": [80, 60]}
    class Ocr:
        def ocr(self, *args, **kwargs):
            return [[[[[10, 10], [30, 10], [30, 20], [10, 20]], ("8.00", .9)]]]
    _, upload = cv2.imencode('.png', np.full((100, 120, 3), 255, dtype=np.uint8))
    with patch.object(svc, 'is_ready', True), patch.object(svc, 'assess', return_value=QualityReport(filename='test', triage='green')), \
         patch.object(svc, 'ocr_model', Ocr()), patch.object(svc, 'rectify', rectify), \
         patch.object(svc, 'postprocess_one', return_value={}), \
         patch.object(svc, 'classify', return_value={'ui_family': 'EST', 'page': 'other'}), \
         patch.object(svc, 'attach_contract'), patch.object(svc, 'validate_channel_observations', return_value=None), \
         patch.object(svc, 'extract_one', return_value={'fields': None, 'status': 'reject', 'warnings': []}):
        result = asyncio.run(svc.recognize_image(UploadFile(file=io.BytesIO(upload.tobytes()), filename='test.png'), include_review_image=True))
    assert len(calls) == 2
    photo = cv2.imdecode(np.frombuffer(base64.b64decode(result['ocr_review_image'].split(',')[1]), np.uint8), cv2.IMREAD_COLOR)
    assert photo.shape[:2] == (60, 80)
    assert abs(float(photo.mean()) - 50) < 2  # rejected rescue must not replace first image
    assert result['ocr_evidence']['lines'][0]['bbox'] == [10, 10, 30, 20]
    assert '_review_image' not in result['ocr_evidence']


def test_field_source_uses_selected_ocr_line():
    def rectify(original, target, meta, max_size=None):
        cv2.imwrite(str(target), np.full((60, 80, 3), 100, dtype=np.uint8))
        return {"ok": True, "screen_size": [80, 60], "original_size": [120, 100],
                "screen_quad": [[10, 10], [90, 10], [90, 70], [10, 70]]}
    class Ocr:
        def ocr(self, *args, **kwargs):
            return [[[[[10, 10], [30, 10], [30, 20], [10, 20]], ("40.00", .9)]]]
    _, upload = cv2.imencode('.png', np.full((100, 120, 3), 255, dtype=np.uint8))
    extraction = {'fields': {'switch_position_sv2_mm': 40}, 'status': 'review', 'warnings': [],
                  'extraction_detail': {'field_sources': {'switch_position_sv2_mm': [
                      {'line_index': 0, 'text': '40.00'}]}}}
    with patch.object(svc, 'is_ready', True), patch.object(svc, 'assess', return_value=QualityReport(filename='test', triage='green')), \
         patch.object(svc, 'ocr_model', Ocr()), patch.object(svc, 'rectify', rectify), \
         patch.object(svc, 'postprocess_one', return_value={}), \
         patch.object(svc, 'classify', return_value={'ui_family': 'TACT', 'page': 'injection_metering'}), \
         patch.object(svc, 'attach_contract'), patch.object(svc, 'validate_channel_observations', return_value=None), \
         patch.object(svc, 'extract_one', return_value=extraction):
        result = asyncio.run(svc.recognize_image(UploadFile(file=io.BytesIO(upload.tobytes()), filename='test.png'), include_review_image=True))
    source = result['field_sources']['switch_position_sv2_mm'][0]
    assert source['line_index'] == 0 and source['bbox'] == [10, 10, 30, 20]
    assert source['original_bbox'] is not None
    assert '_rectify_meta' not in result['ocr_evidence']
