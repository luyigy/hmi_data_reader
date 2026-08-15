"""064 S02：质量门禁前移与安全拒识聚焦测试。

覆盖：
- quality.triage 新增独立机器码 SCREEN_CLIPPED（完整性）与 SEVERE_UNDEREXPOSURE（欠曝）；
- red 多码命中时 reshoot_guidance 只保留一个主提示，yellow 多提示行为不变；
- hmi_service red 短路：不进入 rectify / PaddleOCR / 后处理 / 分类 / 提取，
  响应保留 quality 块四字段与 success/status/fields 契约键；
- green/yellow 路径仍进入 rectify + OCR（前移不改变正常流程）。
"""
from __future__ import annotations

import asyncio
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from quality import QualityMetrics, QualityReport, triage  # noqa: E402


def _report(**metric_overrides) -> QualityReport:
    metrics = QualityMetrics(width=4000, height=3000, **metric_overrides)
    return QualityReport(filename="synthetic", metrics=metrics)


class TriageNewCodesTest(unittest.TestCase):
    def test_small_width_is_review_only_when_screen_fills_frame(self):
        r = _report(screen_bbox=(0, 100, 436, 259), screen_area_ratio=0.65,
                    corners_found=True, blur_score=100.0, perspective_ratio=1.0)
        triage(r)
        self.assertNotIn("SCREEN_TOO_SMALL", r.reject_codes)
        self.assertEqual(r.triage, "yellow")
        self.assertIn("LOW_TEXT_SIZE", r.warn_codes)

    def test_small_distant_screen_remains_rejected(self):
        r = _report(screen_bbox=(100, 100, 436, 259), screen_area_ratio=0.20,
                    corners_found=True, blur_score=100.0, perspective_ratio=1.0)
        triage(r)
        self.assertIn("SCREEN_TOO_SMALL", r.reject_codes)
        self.assertEqual(r.triage, "red")

    def test_screen_clipped_requires_bbox_without_corners(self):
        r = _report(screen_bbox=(0, 100, 3900, 2000), screen_area_ratio=0.8,
                    screen_clipped=True, corners_found=False,
                    blur_score=100.0, perspective_ratio=1.0)
        triage(r)
        self.assertIn("SCREEN_CLIPPED", r.reject_codes)
        self.assertEqual(r.triage, "red")
        self.assertEqual(r.reshoot_guidance, ["屏幕未拍完整，请将完整屏幕框入取景框。"])

    def test_screen_clipped_not_flagged_when_corners_found(self):
        r = _report(screen_bbox=(0, 100, 3900, 2000), screen_area_ratio=0.8,
                    screen_clipped=False, corners_found=True,
                    blur_score=100.0, perspective_ratio=1.0)
        triage(r)
        self.assertNotIn("SCREEN_CLIPPED", r.reject_codes)
        self.assertEqual(r.triage, "green")

    def test_no_bbox_does_not_double_flag_clipped(self):
        r = _report(screen_bbox=None, blur_score=100.0, perspective_ratio=1.0)
        triage(r)
        self.assertEqual(r.reject_codes, ["SCREEN_NOT_FOUND"])
        self.assertNotIn("SCREEN_CLIPPED", r.reject_codes)

    def test_underexposure_requires_roi_dark_and_texture_destroyed(self):
        r = _report(screen_bbox=(100, 100, 3000, 2000), screen_area_ratio=0.8,
                    roi_dark_ratio=0.9, blur_score=50.0, perspective_ratio=1.0)
        triage(r)
        self.assertIn("SEVERE_UNDEREXPOSURE", r.reject_codes)
        self.assertEqual(r.triage, "red")

    def test_underexposure_skipped_for_dark_panel_with_readable_digits(self):
        # 暗底亮字数码管面板：ROI 欠曝比例高但纹理未破坏（blur>=300），不得硬拒
        r = _report(screen_bbox=(100, 100, 3000, 2000), screen_area_ratio=0.8,
                    roi_dark_ratio=0.9, blur_score=800.0, perspective_ratio=1.0)
        triage(r)
        self.assertNotIn("SEVERE_UNDEREXPOSURE", r.reject_codes)
        self.assertEqual(r.triage, "green")

    def test_underexposure_skipped_without_screen_roi(self):
        # 无法定界屏幕 ROI 时安全降级：不下欠曝质量结论（SCREEN_NOT_FOUND 已覆盖）
        r = _report(screen_bbox=None, roi_dark_ratio=0.0, blur_score=50.0,
                    perspective_ratio=1.0)
        triage(r)
        self.assertNotIn("SEVERE_UNDEREXPOSURE", r.reject_codes)


class PrimaryGuidanceTest(unittest.TestCase):
    def test_red_multi_code_keeps_single_primary_guidance(self):
        r = _report(screen_bbox=(0, 100, 3900, 2000), screen_area_ratio=0.8,
                    screen_clipped=True, corners_found=False,
                    blur_score=10.0, perspective_ratio=1.0)
        triage(r)
        self.assertIn("SCREEN_CLIPPED", r.reject_codes)
        self.assertIn("SEVERE_BLUR", r.reject_codes)
        # 主提示优先级：SCREEN_CLIPPED 先于 SEVERE_BLUR
        self.assertEqual(r.reshoot_guidance, ["屏幕未拍完整，请将完整屏幕框入取景框。"])

    def test_red_blur_only_keeps_blur_guidance(self):
        r = _report(screen_bbox=(100, 100, 3000, 2000), screen_area_ratio=0.8,
                    blur_score=10.0, perspective_ratio=1.0)
        triage(r)
        self.assertEqual(r.reject_codes, ["SEVERE_BLUR"])
        self.assertEqual(len(r.reshoot_guidance), 1)
        self.assertIn("模糊", r.reshoot_guidance[0])

    def test_yellow_keeps_multiple_guidance(self):
        # text_h=10(<14) 与屏占比 0.2(<0.30) 各贡献一条提示，yellow 维持多提示行为
        r = _report(screen_bbox=(100, 100, 600, 200), screen_area_ratio=0.2,
                    blur_score=100.0, glare_ratio=0.06, perspective_ratio=1.0)
        triage(r)
        self.assertEqual(r.triage, "yellow")
        self.assertIn("MINOR_GLARE", r.warn_codes)
        self.assertIn("LOW_TEXT_SIZE", r.warn_codes)
        self.assertEqual(len(r.reshoot_guidance), 2)
        self.assertEqual(r.reject_codes, [])


class ServiceShortCircuitTest(unittest.TestCase):
    """red 短路不触碰 rectify/OCR/旁车；green 路径仍走完整流程。"""

    def setUp(self):
        import hmi_service
        self.svc = hmi_service

    def _upload(self, img: np.ndarray):
        from fastapi import UploadFile
        ok, buf = cv2.imencode(".png", img)
        assert ok
        return UploadFile(file=io.BytesIO(buf.tobytes()), filename="synthetic.png")

    def _run(self, upload):
        return asyncio.run(self.svc.recognize_image(file=upload))

    def test_red_short_circuits_before_heavy_pipeline(self):
        calls = {"rectify": 0, "ocr": 0, "postprocess": 0, "classify": 0, "extract": 0}

        class _NoOcr:
            def ocr(self, *a, **k):
                calls["ocr"] += 1
                raise AssertionError("OCR must not run on red images")

        def _counted(name):
            def _fn(*a, **k):
                calls[name] += 1
                raise AssertionError(f"{name} must not run on red images")
            return _fn

        red_img = np.full((600, 800, 3), 128, dtype=np.uint8)  # 纯色：无屏幕 + 模糊
        with mock.patch.object(self.svc, "is_ready", True), \
                mock.patch.object(self.svc, "ocr_model", _NoOcr()), \
                mock.patch.object(self.svc, "rectify", _counted("rectify")), \
                mock.patch.object(self.svc, "postprocess_one", _counted("postprocess")), \
                mock.patch.object(self.svc, "classify", _counted("classify")), \
                mock.patch.object(self.svc, "extract_one", _counted("extract")):
            resp = self._run(self._upload(red_img))

        self.assertEqual(calls, {"rectify": 0, "ocr": 0, "postprocess": 0,
                                 "classify": 0, "extract": 0})
        self.assertTrue(resp["success"] is True)
        self.assertEqual(resp["status"], "reject")
        self.assertEqual(resp["fields"], {})
        self.assertIsInstance(resp["processing_time_ms"], int)
        self.assertGreaterEqual(resp["processing_time_ms"], 0)
        quality = resp["quality"]
        self.assertEqual(set(quality.keys()),
                         {"triage", "reject_codes", "warn_codes", "reshoot_guidance"})
        self.assertEqual(quality["triage"], "red")
        self.assertIn("SCREEN_NOT_FOUND", quality["reject_codes"])
        self.assertIn("SEVERE_BLUR", quality["reject_codes"])
        # red 多码命中：只保留一个主提示
        self.assertEqual(len(quality["reshoot_guidance"]), 1)

    def test_green_still_runs_full_pipeline(self):
        calls = {"rectify": 0, "ocr": 0}

        class _FakeOcr:
            def ocr(self, *a, **k):
                calls["ocr"] += 1
                return []

        def _rectify(orig_path, rect_png, rect_meta):
            calls["rectify"] += 1
            return {"ok": False, "screen_size": (0, 0)}

        green_report = QualityReport(filename="synthetic.png", triage="green")
        with mock.patch.object(self.svc, "is_ready", True), \
                mock.patch.object(self.svc, "assess", return_value=green_report), \
                mock.patch.object(self.svc, "ocr_model", _FakeOcr()), \
                mock.patch.object(self.svc, "rectify", _rectify), \
                mock.patch.object(self.svc, "postprocess_one", return_value={}), \
                mock.patch.object(self.svc, "classify",
                                  return_value={"ui_family": "EST", "page": "other"}), \
                mock.patch.object(self.svc, "attach_contract", lambda *a, **k: None), \
                mock.patch.object(self.svc, "validate_channel_observations",
                                  lambda v: None), \
                mock.patch.object(self.svc, "extract_one",
                                  return_value={"fields": {"x": 1}, "status": "ok",
                                                "warnings": [], "extraction_detail": {}}):
            img = np.full((600, 800, 3), 200, dtype=np.uint8)
            resp = self._run(self._upload(img))

        self.assertEqual(calls, {"rectify": 1, "ocr": 1})
        self.assertEqual(resp["quality"]["triage"], "green")
        self.assertEqual(resp["status"], "ok")
        self.assertEqual(resp["fields"], {"x": 1})


if __name__ == "__main__":
    unittest.main()
