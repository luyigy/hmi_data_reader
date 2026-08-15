"""057 S01 热流道逐槽位通道观察契约（2.8.0 additive）聚焦测试。

覆盖：
- 提取器 detail 输出 hot_runner_channel_observations，与 hot_runner_sv_c 逐位
  对齐：可读槽位 state=ok、黑屏/未读槽位保留为 unreadable，不压缩位置；
- validate_channel_observations 信任边界：1 与 100 槽位接受，0/101 槽位拒绝，
  重复 position、越界 position、非有限/越界 sv_c、非法 state、非法 confidence、
  非 str label、多余/缺失键一律拒绝（返回 None 降级缺省）；
- 合法观察原样返回（服务层据此透出顶层可选键）。
"""
import json
import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from contract import validate_channel_observations
from extract_families.tact_hot_runner import extract_hot_runner_tact


def template(name):
    return json.loads((ROOT / "templates" / name).read_text(encoding="utf-8"))


def observation(position, sv_c=300.0, state="ok", label=None, confidence=None):
    return {"position": position, "label": label, "sv_c": sv_c,
            "state": state, "confidence": confidence}


def make_tokens():
    # 单排 6 通道：PV 上行 5 值，SV 下行 5 值（c 前缀），通道 6 黑屏无值 token；
    # 每通道一组 SOFT/AUTO/MANU 按钮锚点（057 S02 动态槽位：黑屏槽位由可见
    # 单元锚点建立，不再由模板 channels 固定槽数）
    toks = []
    xs = [0.15, 0.29, 0.43, 0.57, 0.71]
    for x, v in zip(xs, (300, 320, 300, 320, 300)):
        toks.append({"text": str(v), "x": x, "y": 0.10, "conf": 0.99, "src": None})
    for x, v in zip(xs, (300, 320, 300, 320, 300)):
        toks.append({"text": f"c{v}", "x": x, "y": 0.16, "conf": 0.99, "src": None})
    for x in xs + [0.85]:
        for j, label in enumerate(("SOFT", "AUTO", "MANU")):
            toks.append({"text": label, "x": x + (j - 1) * 0.045, "y": 0.42,
                         "conf": 0.99, "src": None})
    return toks


class ExtractorObservationTest(unittest.TestCase):
    def test_observations_align_with_hot_runner_sv_c(self):
        result = extract_hot_runner_tact(make_tokens(),
                                         template("tact.hot_runner_temp.json"))
        sv = result["fields"]["hot_runner_sv_c"]
        observations = result["detail"]["hot_runner_channel_observations"]
        self.assertEqual(len(observations), len(sv))
        self.assertEqual([o["position"] for o in observations], [1, 2, 3, 4, 5, 6])
        self.assertEqual([o["sv_c"] for o in observations], sv)
        self.assertEqual([o["state"] for o in observations],
                         ["ok", "ok", "ok", "ok", "ok", "unreadable"])
        self.assertTrue(all(o["label"] is None for o in observations))
        self.assertTrue(all(o["confidence"] is None for o in observations))
        # 观察通过服务边界校验（produce 即合法）
        self.assertIs(validate_channel_observations(observations), observations)

    def test_reject_path_has_no_observations(self):
        # 取值行不足（VALUE_ROWS_MISSING）安全拒识时不产生观察键
        result = extract_hot_runner_tact([{"text": "c300", "x": 0.15, "y": 0.16,
                                           "conf": 0.99, "src": None}],
                                         template("tact.hot_runner_temp.json"))
        self.assertIsNone(result["fields"])
        self.assertNotIn("hot_runner_channel_observations", result["detail"])


class ValidateChannelObservationsTest(unittest.TestCase):
    def test_none_and_valid_passthrough(self):
        self.assertIsNone(validate_channel_observations(None))
        valid = [observation(1, 300.0), observation(2, None, state="blackout"),
                 observation(3, None, state="unreadable", label="CH3",
                             confidence=0.5)]
        self.assertIs(validate_channel_observations(valid), valid)

    def test_accepts_1_and_100_slots(self):
        self.assertIsNotNone(validate_channel_observations([observation(1)]))
        hundred = [observation(i) for i in range(1, 101)]
        self.assertIs(validate_channel_observations(hundred), hundred)

    def test_rejects_0_and_101_slots(self):
        self.assertIsNone(validate_channel_observations([]))
        self.assertIsNone(validate_channel_observations(
            [observation(i) for i in range(1, 102)]))

    def test_rejects_duplicate_and_out_of_range_positions(self):
        self.assertIsNone(validate_channel_observations(
            [observation(1), observation(1, 320.0)]))
        self.assertIsNone(validate_channel_observations([observation(0)]))
        self.assertIsNone(validate_channel_observations([observation(101)]))
        self.assertIsNone(validate_channel_observations([observation(1.5)]))
        self.assertIsNone(validate_channel_observations([observation(True)]))

    def test_rejects_non_finite_or_out_of_range_sv(self):
        for bad in (math.inf, -math.inf, math.nan, -100.1, 500.1, "300", True):
            self.assertIsNone(validate_channel_observations(
                [observation(1, bad)]), f"sv_c={bad!r}")

    def test_rejects_bad_state_label_confidence_and_keys(self):
        self.assertIsNone(validate_channel_observations(
            [observation(1, state="missing")]))
        self.assertIsNone(validate_channel_observations([observation(1, label=3)]))
        self.assertIsNone(validate_channel_observations(
            [observation(1, label="x" * 51)]))
        self.assertIsNone(validate_channel_observations(
            [observation(1, confidence=1.1)]))
        self.assertIsNone(validate_channel_observations(
            [observation(1, confidence=math.nan)]))
        extra = {**observation(1), "note": "extra"}
        self.assertIsNone(validate_channel_observations([extra]))
        missing = observation(1)
        del missing["label"]
        self.assertIsNone(validate_channel_observations([missing]))
        self.assertIsNone(validate_channel_observations(["not-a-dict"]))
        self.assertIsNone(validate_channel_observations({"position": 1}))


if __name__ == "__main__":
    unittest.main()
