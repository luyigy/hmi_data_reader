"""057 S02 热流道动态槽位提取聚焦测试（生成 token + 合成显示区图像）。

覆盖（PLAN 057 §5 验收口径，单一动态函数，不按通道数分支）：
- 1 / 6 / 7 / 12（双排）/ 100 通道的槽位数与图内物理顺序；
- 中间黑屏：槽位保留不左移，合成图暗区 -> blackout、无图 -> unreadable、
  亮区（OCR 漏读）-> unreadable，不冒充已确认黑屏；
- 边界缺失：右缘通道按钮锚点 OCR 全丢时，画面证据内最多外推 1 槽；
- 部分面板（只见右半）：position 仍是图内顺序 1..N，不伪造全局通道号；
- 通道标签非连续：面板印刷号原样挂载，不从 position 推断；
- 旋转面板（YUDO 斜拍同视觉行 y 漂移）：去旋转后正确聚行；
- 超过 100 槽位安全拒识（CHANNEL_LIMIT_EXCEEDED），不截断；
- 无锚点纯值网格回退（hr_A01 型特写面板）。
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from contract import validate_channel_observations
from extract_families.tact_hot_runner import _sv_value, extract_hot_runner_tact


def template(name="tact.hot_runner_temp.json"):
    return json.loads((ROOT / "templates" / name).read_text(encoding="utf-8"))


def panel_tokens(n_rows, n_cols, *, x0=0.10, step=0.14, sv_y0=0.16,
                 row_gap=0.50, slope=0.0, values=None, black=(),
                 anchors=True, extra=()):
    """生成面板 token：每单元 PV（上行纯数字）+ SV（下行 c 前缀）+ 按钮锚点。

    values: {(row, col): sv} 缺省全 300；black: {(row, col)} 黑屏槽（无值
    token、锚点保留）；slope: 面板旋转（y 随 x 线性漂移）。
    """
    values = values or {}
    toks = []
    for r in range(n_rows):
        for c in range(n_cols):
            x = x0 + c * step
            y_sv = sv_y0 + r * row_gap + slope * x
            if (r, c) not in black:
                v = values.get((r, c), 300)
                toks.append({"text": str(v), "x": x, "y": y_sv - 0.05,
                             "conf": 0.99, "src": None})
                toks.append({"text": f"c{v}", "x": x, "y": y_sv,
                             "conf": 0.99, "src": None})
            if anchors:
                for j, label in enumerate(("SOFT", "AUTO", "MANU")):
                    toks.append({"text": label, "x": x + (j - 1) * 0.3 * step,
                                 "y": y_sv + 0.12, "conf": 0.99, "src": None})
    toks.extend(extra)
    return toks


def make_image(lit=(), n_rows=1, n_cols=6, *, x0=0.10, step=0.14, sv_y0=0.16,
               row_gap=0.50, edge_window=False, size=1000):
    """合成面板图像：亮色面板底 + 每单元暗显示窗，lit 槽位显示窗内画亮绿块
    （数码管点亮）。暗显示窗 -> blackout 探针；亮绿 -> unreadable（亮但未读）。
    edge_window=True 时在最后一列之后再画一个暗显示窗（边缘外推候选用）。"""
    image = np.full((size, size, 3), (230, 200, 180), dtype=np.uint8)  # 亮面板
    for r in range(n_rows):
        for c in range(n_cols + (1 if edge_window else 0)):
            x = x0 + c * step
            y = sv_y0 + r * row_gap
            cx, cy = int(x * size), int(y * size)
            cv2.rectangle(image, (cx - 55, cy - 25), (cx + 55, cy + 25),
                          (15, 15, 15), -1)  # 暗显示窗（须覆盖探针窗）
            if (r, c) in lit:
                cv2.rectangle(image, (cx - 40, cy - 14), (cx + 40, cy + 14),
                              (0, 255, 0), -1)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    cv2.imwrite(tmp.name, image)
    return tmp.name


def observations(result):
    return result["detail"]["hot_runner_channel_observations"]


class DynamicSlotCountTest(unittest.TestCase):
    """1 / 6 / 7 / 12 / 100 通道：槽位数与顺序由面板结构推导，与模板 channels 无关。"""

    def test_single_channel(self):
        result = extract_hot_runner_tact(panel_tokens(1, 1), template())
        self.assertEqual(result["fields"]["hot_runner_sv_c"], [300.0])
        self.assertEqual([o["position"] for o in observations(result)], [1])

    def test_six_channels(self):
        values = {(0, c): 300 + c * 10 for c in range(6)}
        result = extract_hot_runner_tact(panel_tokens(1, 6, values=values),
                                         template())
        self.assertEqual(result["fields"]["hot_runner_sv_c"],
                         [300.0, 310.0, 320.0, 330.0, 340.0, 350.0])

    def test_seven_channels(self):
        result = extract_hot_runner_tact(panel_tokens(1, 7), template())
        self.assertEqual(len(result["fields"]["hot_runner_sv_c"]), 7)
        self.assertEqual([o["position"] for o in observations(result)],
                         list(range(1, 8)))

    def test_twelve_channels_two_rows_keep_row_major_order(self):
        values = {(r, c): 300 + r * 6 + c for r in range(2) for c in range(6)}
        result = extract_hot_runner_tact(
            panel_tokens(2, 6, values=values), template())
        self.assertEqual(result["fields"]["hot_runner_sv_c"],
                         [float(300 + i) for i in range(12)])
        obs = observations(result)
        self.assertEqual([o["position"] for o in obs], list(range(1, 13)))
        self.assertTrue(all(o["state"] == "ok" for o in obs))
        # 产出即合法（服务层信任边界校验通过）
        self.assertIs(validate_channel_observations(obs), obs)

    def test_hundred_channels(self):
        result = extract_hot_runner_tact(
            panel_tokens(4, 25, x0=0.05, step=0.036, row_gap=0.22), template())
        sv = result["fields"]["hot_runner_sv_c"]
        self.assertEqual(len(sv), 100)
        self.assertEqual([o["position"] for o in observations(result)],
                         list(range(1, 101)))

    def test_over_hundred_channels_rejects_safely(self):
        result = extract_hot_runner_tact(
            panel_tokens(1, 101, x0=0.02, step=0.009), template())
        self.assertIsNone(result["fields"])
        self.assertIn("CHANNEL_LIMIT_EXCEEDED(101)", result["warnings"])
        self.assertNotIn("hot_runner_channel_observations", result["detail"])

    def test_c_prefix_misread_keeps_full_temperature(self):
        self.assertEqual(
            [_sv_value(t) for t in ("2190", "2210", "2220", "2310", "3100")],
            [190.0, 210.0, 220.0, 310.0, 310.0])


class BlackoutStateTest(unittest.TestCase):
    """黑屏槽位保留与 blackout/unreadable 语义（契约 2.8.0）。"""

    TOKENS_BLACK_CH3 = panel_tokens(1, 6, black={(0, 2)},
                                    values={(0, 3): 340, (0, 1): 320,
                                            (0, 4): 300, (0, 5): 320})

    def test_middle_blackout_keeps_position_with_dark_probe(self):
        image = make_image()  # 全暗：黑屏显示区探测确认
        result = extract_hot_runner_tact(self.TOKENS_BLACK_CH3, template(),
                                         image_path=image)
        self.assertEqual(result["fields"]["hot_runner_sv_c"],
                         [300.0, 320.0, None, 340.0, 300.0, 320.0])
        obs = observations(result)
        self.assertEqual([o["state"] for o in obs],
                         ["ok", "ok", "blackout", "ok", "ok", "ok"])
        self.assertEqual(obs[2]["position"], 3)  # 黑屏后续通道不左移
        self.assertIs(validate_channel_observations(obs), obs)

    def test_missing_value_without_image_is_unreadable(self):
        result = extract_hot_runner_tact(self.TOKENS_BLACK_CH3, template())
        self.assertEqual(result["fields"]["hot_runner_sv_c"][2], None)
        self.assertEqual(observations(result)[2]["state"], "unreadable")

    def test_lit_but_ocr_missed_is_unreadable_not_blackout(self):
        image = make_image(lit={(0, 2)})  # 显示亮但无 token（OCR 漏读）
        result = extract_hot_runner_tact(self.TOKENS_BLACK_CH3, template(),
                                         image_path=image)
        self.assertEqual(observations(result)[2]["state"], "unreadable")

    def test_left_edge_blackout_not_dropped(self):
        # 通道 1 黑屏：槽位保留在 position 1，右侧值不左移
        toks = panel_tokens(1, 6, black={(0, 0)}, values={(0, 1): 320})
        result = extract_hot_runner_tact(toks, template())
        sv = result["fields"]["hot_runner_sv_c"]
        self.assertEqual(len(sv), 6)
        self.assertIsNone(sv[0])
        self.assertEqual(sv[1], 320.0)

    def test_repeated_chinese_brand_headers_anchor_black_slots(self):
        toks = []
        values = {1: 185, 3: 230, 4: 240, 5: 240}
        for c in range(6):
            x = 0.10 + c * 0.14
            toks.append({"text": "龙昌兴", "x": x, "y": 0.28,
                         "conf": 0.99, "src": None})
            if c in values:
                value = values[c]
                toks.extend([
                    {"text": str(value), "x": x, "y": 0.11,
                     "conf": 0.99, "src": None},
                    {"text": f"c{value}", "x": x, "y": 0.16,
                     "conf": 0.99, "src": None},
                ])
        result = extract_hot_runner_tact(toks, template())
        self.assertEqual(result["fields"]["hot_runner_sv_c"],
                         [None, 185.0, None, 230.0, 240.0, 240.0])


class BoundaryAndPartialPanelTest(unittest.TestCase):
    """边界缺失外推（仅图像确认暗显示窗）与部分面板不伪造全局通道号。"""

    def test_right_edge_extrapolated_once_when_probe_confirms_dark(self):
        # 通道 6 黑屏且按钮锚点 OCR 全丢：矫正图在候选槽位确认暗显示窗，
        # 最多外推 1 槽（hr_A06_458f23df 斜拍真图情形）
        toks = panel_tokens(1, 5)
        image = make_image(n_cols=5, edge_window=True)
        result = extract_hot_runner_tact(toks, template(), image_path=image)
        sv = result["fields"]["hot_runner_sv_c"]
        self.assertEqual(len(sv), 6)
        self.assertIsNone(sv[5])
        self.assertEqual(observations(result)[5]["state"], "blackout")

    def test_no_extrapolation_without_image_or_when_bright(self):
        toks = panel_tokens(1, 5)
        # 无图：不外推
        result = extract_hot_runner_tact(toks, template())
        self.assertEqual(len(result["fields"]["hot_runner_sv_c"]), 5)
        # 候选槽位亮（面板，非黑屏显示窗）：不外推，不幻影槽位
        image = make_image(n_cols=5)
        result = extract_hot_runner_tact(toks, template(), image_path=image)
        self.assertEqual(len(result["fields"]["hot_runner_sv_c"]), 5)

    def test_partial_panel_does_not_fabricate_global_numbers(self):
        # 只看到面板右半（6 个可见单元，无任何左半 token）：
        # position 仍是图内顺序 1..6，不猜全局 7-12，label 不伪造
        values = {(0, c): 300 + c * 5 for c in range(6)}
        toks = panel_tokens(1, 6, x0=0.42, step=0.10, values=values)
        result = extract_hot_runner_tact(toks, template())
        sv = result["fields"]["hot_runner_sv_c"]
        self.assertEqual(sv, [300.0, 305.0, 310.0, 315.0, 320.0, 325.0])
        obs = observations(result)
        self.assertEqual([o["position"] for o in obs], [1, 2, 3, 4, 5, 6])
        self.assertTrue(all(o["label"] is None for o in obs))


class ChannelLabelTest(unittest.TestCase):
    """通道标签：可读时挂面板印刷号（含非连续），冲突/不可读保持 None。"""

    def test_noncontiguous_labels_attached_verbatim(self):
        # 面板印刷号非连续（1,2,4,5,6,7）：原样挂载，不从 position 推断
        labels = ["1", "2", "4", "5", "6", "7"]
        extra = [{"text": t, "x": 0.10 + c * 0.14, "y": 0.41,
                  "conf": 0.99, "src": None} for c, t in enumerate(labels)]
        result = extract_hot_runner_tact(panel_tokens(1, 6, extra=extra),
                                         template())
        self.assertEqual([o["label"] for o in observations(result)], labels)

    def test_conflicting_label_candidates_stay_none(self):
        extra = [{"text": "2", "x": 0.235, "y": 0.41, "conf": 0.99, "src": None},
                 {"text": "12", "x": 0.245, "y": 0.41, "conf": 0.99, "src": None}]
        result = extract_hot_runner_tact(panel_tokens(1, 6, extra=extra),
                                         template())
        self.assertIsNone(observations(result)[1]["label"])


class RotatedPanelTest(unittest.TestCase):
    """旋转面板：同一视觉行 y 漂移时去旋转聚行（YUDO 斜拍错位根因）。"""

    def test_rotated_rows_recovered(self):
        values = {(r, c): 290 for r in range(2) for c in range(3)}
        toks = panel_tokens(2, 3, x0=0.10, step=0.15, slope=-0.20,
                            values=values)
        result = extract_hot_runner_tact(toks, template())
        self.assertEqual(result["fields"]["hot_runner_sv_c"], [290.0] * 6)
        self.assertIn("rotate_slope", result["detail"])

    def test_anchorless_value_grid_fallback(self):
        # hr_A01 型特写：无按钮锚点，纯值网格仍按图内顺序出槽
        toks = panel_tokens(1, 6, anchors=False,
                            values={(0, c): 205 + c * 10 for c in range(6)})
        result = extract_hot_runner_tact(toks, template())
        self.assertEqual(result["fields"]["hot_runner_sv_c"],
                         [205.0, 215.0, 225.0, 235.0, 245.0, 255.0])


if __name__ == "__main__":
    unittest.main()
