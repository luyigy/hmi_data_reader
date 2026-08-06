"""034_FIX 摩尔纹抑制变体测试。

- moire_suppress：合成 3px 周期屏幕网格条纹图，断言高斯低通后条纹频段
  能量显著衰减且图幅/ dtype 不变；
- rank05 token 流仿真：主 OCR 相邻格粘连（'30.090.0'/'22.00-29.00' 被数值
  fullmatch 过滤）+ 变体拆格 token（_src="ocr_variant"）经 _extract_curve
  合并后恢复 [110,90,30]/[50,29,22]，深色禁用槽（40.0/22.30）被 Layer 1
  观测剔除；
- _extract_global_pressure：变体段值 token 落入锚带时主 OCR 值优先
  （rank05 '30.0' 盖 '110.0' 回归），主 OCR 整带漏检时变体兜底。
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from extract_families.demag_injection import _extract_curve, _extract_global_pressure
from ocr_variants import moire_suppress


def _band_energy(img, p_lo=1.8, p_hi=3.2):
    """周期在 [p_lo, p_hi] px 频段的 FFT 能量（条纹频段）。"""
    f = np.fft.fftshift(np.fft.fft2(img.astype(np.float32) - img.mean()))
    h, w = img.shape
    yy, xx = np.mgrid[0:h, 0:w]
    per = 1.0 / np.sqrt(((xx - w // 2) / w) ** 2 + ((yy - h // 2) / h) ** 2 + 1e-12)
    return float(np.abs(f[(per >= p_lo) & (per <= p_hi)]).sum())


class MoireSuppressTest(unittest.TestCase):
    def test_stripe_band_energy_attenuated(self):
        img = np.full((200, 400), 180, dtype=np.uint8)
        img[:, ::3] = 60  # 3px 周期竖条纹（rank05 实测屏幕网格 2.3px 同级频段）
        out = moire_suppress(img)
        self.assertEqual(out.shape, img.shape)
        self.assertEqual(out.dtype, img.dtype)
        # 3x3 高斯核 [0.25,0.5,0.25] 在 f=1/3 处幅值响应 0.25，留安全余量取 0.35
        self.assertLess(_band_energy(out), 0.35 * _band_energy(img))

    def test_plain_image_unchanged_geometry(self):
        img = np.tile(np.linspace(0, 255, 400, dtype=np.uint8), (200, 1))
        out = moire_suppress(img)
        self.assertEqual(out.shape, img.shape)
        self.assertLess(abs(float(out.mean()) - float(img.mean())), 1.0)


def _rank05_toks():
    """rank05 段表 token 流仿真：主 OCR 粘连格 + 摩尔纹变体拆格。"""
    toks = [
        {"text": "多级注射", "x": 0.3, "y": 0.1},
        {"text": "压力[bar]", "x": 0.22, "y": 0.68},
        {"text": "速度[mm/s]", "x": 0.22, "y": 0.72},
        {"text": "位置[mm]", "x": 0.22, "y": 0.75},
        # 左列 保压压力/保压速度/V-P 切换位置
        {"text": "70.0", "x": 0.30, "y": 0.68},
        {"text": "15.0", "x": 0.30, "y": 0.72},
        {"text": "16.6", "x": 0.30, "y": 0.75},
        # 全局射胶压力上限（段表上方）
        {"text": "110.0", "x": 0.90, "y": 0.63},
        # 段表上 row（段速度，屏幕自右向左）：主 OCR 粘连 + 变体拆格
        {"text": "110.0", "x": 0.906, "y": 0.68},
        {"text": "40.0", "x": 0.708, "y": 0.68},
        {"text": "30.090.0", "x": 0.808, "y": 0.68},  # 粘连格，fullmatch 过滤
        {"text": "90.0", "x": 0.844, "y": 0.68, "src": "ocr_variant"},
        {"text": "30.0", "x": 0.777, "y": 0.68, "src": "ocr_variant"},
        # 段表下 row（段位置）
        {"text": "50.00", "x": 0.906, "y": 0.72},
        {"text": "22.30", "x": 0.704, "y": 0.72},
        {"text": "22.00-29.00", "x": 0.807, "y": 0.72},  # 粘连格
        {"text": "29.00", "x": 0.840, "y": 0.72, "src": "ocr_variant"},
        {"text": "22.00", "x": 0.773, "y": 0.72, "src": "ocr_variant"},
    ]
    return toks


def _rank05_img():
    """合成段表亮度图：最左列（x≈0.71）为深色禁用槽，其余白格。"""
    img = np.full((200, 260), 200, dtype=np.uint8)
    h, w = img.shape
    img[int(0.64 * h):int(0.76 * h), int(0.68 * w):int(0.735 * w)] = 80
    return img


class Rank05TokenStreamTest(unittest.TestCase):
    TEMPLATE = {"curve_page": {
        "row_y_hint": {"pressure": 0.68, "velocity": 0.72, "position": 0.75},
        "global_pressure": {"x_min": 0.75, "dy_above": [-0.005, 0.08]},
    }}

    def test_variant_tokens_restore_glued_cells(self):
        warnings = []
        fields = _extract_curve(_rank05_toks(), self.TEMPLATE["curve_page"],
                                warnings, img=_rank05_img())
        self.assertEqual(fields["stage_velocity_mms"], [110.0, 90.0, 30.0])
        self.assertEqual(fields["stage_position_mm"], [50.0, 29.0, 22.0])
        self.assertEqual(fields["injection_pressure_limit_bar"], 110.0)
        self.assertEqual(warnings, [])

    def test_without_variant_keeps_base_behavior(self):
        # 无变体 token 时输出不恢复（粘连格仍丢失），证明恢复来自变体
        toks = [t for t in _rank05_toks() if t.get("src") != "ocr_variant"]
        warnings = []
        fields = _extract_curve(toks, self.TEMPLATE["curve_page"],
                                warnings, img=_rank05_img())
        self.assertEqual(fields["stage_velocity_mms"], [110.0, 40.0])
        self.assertEqual(fields["stage_position_mm"], [50.0, 22.3])


class GlobalPressureMainPriorityTest(unittest.TestCase):
    TPL = {"global_pressure": {"x_min": 0.75, "dy_above": [-0.005, 0.08]}}

    def test_main_beats_variant_in_band(self):
        toks = [
            {"text": "110.0", "x": 0.90, "y": 0.63},
            {"text": "30.0", "x": 0.80, "y": 0.675, "src": "ocr_variant"},
        ]
        warnings = []
        self.assertEqual(_extract_global_pressure(toks, 0.68, self.TPL, warnings), 110.0)
        self.assertEqual(warnings, [])

    def test_variant_fallback_when_main_missing(self):
        toks = [{"text": "95.0", "x": 0.90, "y": 0.63, "src": "ocr_variant"}]
        warnings = []
        self.assertEqual(_extract_global_pressure(toks, 0.68, self.TPL, warnings), 95.0)
        self.assertEqual(warnings, [])


if __name__ == "__main__":
    unittest.main()
