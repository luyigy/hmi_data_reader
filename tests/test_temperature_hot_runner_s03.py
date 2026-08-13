"""042 S03 热流道 Profile 聚焦回归。

覆盖：
- 计次锚点 _anchor_hits（{"text","min_count"}）在共享路由的语义与向后兼容；
- 斜拍全景（无品牌表头、MANU 多实例）经模板指纹兜底路由到 TACT hot_runner_temp；
- Hot-system 单通道温控器（MANU 仅 1 次）不命中指纹，稳定拒识；
- TACT 数码管提取器输出契约字段 hot_runner_sv_c，黑屏通道 null、物理顺序保持；
- attach_contract 对 hot_runner_sv_c 给出 field_meta（web_target=hot_runner_zone_temperature_set）。
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from contract import attach_contract
from extract_families.common import _anchor_hits
from extract_families.tact_hot_runner import extract_hot_runner_tact
from extract_fields import detect_family_from_templates, route_page


def template(name):
    return json.loads((ROOT / "templates" / name).read_text(encoding="utf-8"))


def line(text, y_min=0.0):
    return {"text": text, "conf": 0.99,
            "bbox": {"x_min": 0.0, "y_min": y_min, "x_max": 1.0, "y_max": y_min + 1.0}}


class AnchorHitsTest(unittest.TestCase):
    def test_string_and_list_candidates_keep_legacy_semantics(self):
        texts = ["龙昌兴", "E-mail:dgminhui@126.com"]
        self.assertTrue(_anchor_hits("龙昌兴", texts))
        self.assertTrue(_anchor_hits(["YUDO", "HOT RUNNER", "龙昌兴"], texts))
        self.assertFalse(_anchor_hits(["YUDO", "CW301"], texts))

    def test_count_anchor_requires_min_occurrences(self):
        multi = ["SOFT", "AUTO", "MANU", "SOFT", "AUTO", "MANU", "300", "2300"]
        single = ["Hot-system", "Temperature Controller", "PV", "SV", "MANU", "SET"]
        anchor = {"text": "MANU", "min_count": 2}
        self.assertTrue(_anchor_hits([anchor], multi))
        self.assertFalse(_anchor_hits([anchor], single))

    def test_count_anchor_rejects_invalid_spec(self):
        texts = ["MANU", "MANU"]
        self.assertFalse(_anchor_hits({"text": "", "min_count": 1}, texts))
        self.assertFalse(_anchor_hits({"text": "MANU", "min_count": 0}, texts))
        self.assertFalse(_anchor_hits({"text": "MANU", "min_count": "2"}, texts))
        self.assertFalse(_anchor_hits({"text": "MANU", "min_count": True}, texts))


class ObliquePanoramaRoutingTest(unittest.TestCase):
    """hr_A06_458f23df 斜拍全景：品牌表头不可读，仅靠 MANU 多实例结构指纹。"""

    # 该图实测 OCR 文本（2000x1405 矫正后）：无任何 龙昌兴/HOT RUNNER 表头
    OBLIQUE_TEXTS = [
        "300", "320", "300", "320", "300",
        "2300", "2320", "2300", "2320", "2300",
        "SOFT", "AUTO", "MANU", "SOFT", "AUTO", "MANU",
        "SOFT", "AUTO", "MANU", "AUTO", "ANL", "CAUTION", "REMO",
    ]

    def test_family_fallback_hits_tact_via_count_anchor(self):
        fam = detect_family_from_templates(
            [line(t) for t in self.OBLIQUE_TEXTS], ROOT / "templates")
        self.assertEqual(fam, "TACT")

    def test_page_routes_to_hot_runner_temp(self):
        page, src = route_page("raw_upload", [line(t) for t in self.OBLIQUE_TEXTS],
                               "TACT", ROOT / "templates")
        self.assertEqual((page, src), ("hot_runner_temp", "template_anchors"))


class SingleZoneRejectionTest(unittest.TestCase):
    """Hot-system 单通道温控器（hr_A09_*）：MANU 仅 1 次，不命中指纹。"""

    SINGLE_ZONE_TEXTS = [
        "Hot-system", "Temperature Controller", "1800", "PV",
        "180J", "SV", "OUT", "MANU", "SET", "M",
    ]

    def test_family_fallback_does_not_fire(self):
        fam = detect_family_from_templates(
            [line(t) for t in self.SINGLE_ZONE_TEXTS], ROOT / "templates")
        self.assertIsNone(fam)

    def test_page_does_not_route_to_hot_runner(self):
        # 即使家族被其他先验判为 TACT，页面锚点也不得命中热流道模板
        page, _ = route_page("raw_upload", [line(t) for t in self.SINGLE_ZONE_TEXTS],
                             "TACT", ROOT / "templates")
        self.assertNotEqual(page, "hot_runner_temp")


class HotRunnerExtractorContractTest(unittest.TestCase):
    """多排物理顺序展开、黑屏通道 null、契约字段名 hot_runner_sv_c。"""

    def make_tokens(self):
        # 单排 6 通道：PV 上行 5 值，SV 下行 5 值（c 前缀），通道 6 黑屏无 token
        toks = []
        xs = [0.15, 0.29, 0.43, 0.57, 0.71]
        for x, v in zip(xs, (300, 320, 300, 320, 300)):
            toks.append({"text": str(v), "x": x, "y": 0.10, "conf": 0.99, "src": None})
        for x, v in zip(xs, (300, 320, 300, 320, 300)):
            toks.append({"text": f"c{v}", "x": x, "y": 0.16, "conf": 0.99, "src": None})
        return toks

    def test_contract_field_name_and_black_channel_null(self):
        result = extract_hot_runner_tact(self.make_tokens(),
                                         template("tact.hot_runner_temp.json"))
        self.assertEqual(result["warnings"], [])
        self.assertNotIn("sv_c", result["fields"])
        self.assertEqual(result["fields"]["hot_runner_sv_c"],
                         [300.0, 320.0, 300.0, 320.0, 300.0, None])

    def test_field_meta_attached_from_catalog(self):
        result = extract_hot_runner_tact(self.make_tokens(),
                                         template("tact.hot_runner_temp.json"))
        contract_result = {
            "controller_family": "TACT", "page_type": "hot_runner_temp",
            "fields": result["fields"], "extraction_detail": result["detail"],
        }
        attach_contract(contract_result)
        self.assertEqual(contract_result["profile_id"], "tact.hot_runner_temp.digital_sv")
        self.assertEqual(contract_result["profile_status"], "candidate")
        meta = contract_result["field_meta"].get("hot_runner_sv_c")
        self.assertIsNotNone(meta)
        self.assertEqual(meta["web_target"], "hot_runner_zone_temperature_set")
        self.assertEqual(meta["unit"], "°C")
        self.assertEqual(meta["role"], "setpoint")


if __name__ == "__main__":
    unittest.main()
