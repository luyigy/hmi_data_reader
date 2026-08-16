"""042 S02 炮筒温度 Profile 聚焦回归。"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from classify_ui import find_page, find_ui_family
from contract import attach_contract
from extract_fields import extract_temperature
from extract_families.b_and_r import extract_temperature_b_and_r
from extract_families.fanuc import extract_temperature_fanuc
from ocr_variants import _gated_cell_num, generate_demag_rate_sidecar


def token(text, x, y, *, src=None):
    value = {"text": text, "x": x, "y": y, "conf": 0.99}
    if src:
        value["src"] = src
    return value


def template(name):
    return json.loads((ROOT / "templates" / name).read_text(encoding="utf-8"))


class DemagRateCellsTest(unittest.TestCase):
    def test_two_complete_rec_reads_beat_truncated_det(self):
        crop = np.zeros((20, 40, 3), dtype=np.uint8)
        with mock.patch("ocr_variants._run_rec",
                        side_effect=[("295.0", 0.99), ("295.0", 0.98)]), \
                mock.patch("ocr_variants._det_rec", return_value=("295", 1.0)):
            self.assertEqual(_gated_cell_num(None, crop), ("295.0", 0.99))

    def test_five_top_cells_and_negative_sign_are_preserved(self):
        class FakeOcr:
            # 083 S10：读取升级为 _gated_cell_num 三读门禁（raw rec / 抑制 rec /
            # det 各一次）；每格三读同值且 det conf>=0.9 无冲突 -> 按 det 读录取。
            VALUES = ("25", "15", "3", "41", "-8")

            def __init__(self):
                self.calls = 0

            def ocr(self, _image, det=False, **_kwargs):
                value = self.VALUES[self.calls // 3]
                self.calls += 1
                if det:
                    box = [[0, 0], [1, 0], [1, 1], [0, 1]]
                    return [[(box, (value, 0.99))]]
                return [[(value, 0.99)]]

        with tempfile.TemporaryDirectory() as tmp:
            image = np.zeros((400, 800, 3), dtype=np.uint8)
            for x in (80, 200, 320, 440, 560):
                cv2.rectangle(image, (x, 55), (x + 60, 85), (255, 180, 80), -1)
                cv2.rectangle(image, (x, 140), (x + 60, 170), (255, 180, 80), -1)
            png = Path(tmp) / "demag.png"
            out = Path(tmp) / "demag.ocr_rates.json"
            cv2.imwrite(str(png), image)

            self.assertEqual(generate_demag_rate_sidecar(FakeOcr(), png, out), 5)
            lines = json.loads(out.read_text(encoding="utf-8"))["lines"]
            self.assertEqual([line["text"] for line in lines],
                             ["25", "15", "3", "41", "-8"])
            self.assertTrue(all(line["_src"] == "rate_cell" for line in lines))


class BandRFiveColumnTest(unittest.TestCase):
    def make_tokens(self):
        toks = [token(name, x, 0.2) for name, x in zip(
            ("NZ", "#1", "#2", "#3", "#4"), (0.2, 0.3, 0.4, 0.5, 0.6))]
        rows = (("实际温度", 0.30, 200), ("设定温度", 0.35, 200),
                ("高温偏差", 0.40, 10), ("低温偏差", 0.45, 5),
                ("加热输出", 0.50, 20))
        for label, y, value in rows:
            toks.append(token(label, 0.05, y))
            toks.extend(token(str(value), x, y) for x in (0.2, 0.3, 0.4, 0.5, 0.6))
        return toks

    def test_nz_through_four_maps_without_phantom_fifth_zone(self):
        result = extract_temperature_b_and_r(
            self.make_tokens(), template("b_and_r.temperature.json"))
        self.assertEqual(result["heater_columns"], 5)
        self.assertEqual(result["warnings"], [])
        self.assertEqual(result["fields"]["barrel_temperature_set_c"],
                         [200.0, 200.0, 200.0, 200.0, 200.0, None])

    def test_missing_middle_header_is_not_accepted_as_five_column_layout(self):
        toks = [t for t in self.make_tokens() if t["text"] != "#3"]
        result = extract_temperature_b_and_r(toks, template("b_and_r.temperature.json"))
        self.assertEqual(result["heater_columns"], 6)
        self.assertTrue(any(w.startswith("COLUMN_CLUSTER_COUNT")
                            for w in result["warnings"]), result["warnings"])


class FanucTemperatureCellsTest(unittest.TestCase):
    def test_cell_rows_restore_set_current_and_keep_candidate(self):
        # 083 S04：profile 已豁免晋级 verified（见 profiles.json lifecycle_note），
        # 本用例保留逐格旁车恢复 set/current 的提取行为断言，状态断言跟随晋级。
        rows = {"现在": (0.30, [290, 285, 275, 270, 45]),
                "输出": (0.35, [36.5, 12.6, 6.3, 52.4, 100]),
                "上限": (0.40, [5, 5, 5, 5, 10]),
                "设定": (0.45, [290, 285, 275, 270, 45]),
                "下限": (0.50, [5, 5, 5, 5, 10])}
        toks = [token("低温保持", 0.08, 0.10), token("200.0", 0.20, 0.10)]
        for label, (y, values) in rows.items():
            toks.append(token(label, 0.10, y))
            toks.extend(token(str(value), x, y, src="fanuc_cell")
                        for x, value in zip((0.35, 0.42, 0.49, 0.56, 0.63), values))

        result = extract_temperature_fanuc(toks, template("fanuc.temperature.json"))
        self.assertEqual(result["warnings"], [])
        self.assertEqual(result["fields"]["barrel_temperature_current_c"],
                         [290.0, 285.0, 275.0, 270.0])
        self.assertEqual(result["fields"]["drop_port_temperature_current_c"], 45.0)
        contract = attach_contract({"status": "ok", "warnings": [],
                                    "controller_family": "FANUC",
                                    "page_type": "temperature",
                                    "fields": result["fields"],
                                    "extraction_detail": result["detail"]})
        self.assertEqual(contract["profile_id"], "fanuc.temperature.rightmost5")
        self.assertEqual(contract["profile_status"], "verified")


class FanucAliasRoutingTest(unittest.TestCase):
    def test_explicit_chinese_alias_and_temperature_title(self):
        lines = [{"text": "发那科", "conf": 0.99, "bbox": {"y_min": 0}},
                 {"text": "喷嘴/料筒", "conf": 0.98, "bbox": {"y_min": 20}}]
        lines.extend({"text": text, "conf": 0.97, "bbox": {"y_min": y}}
                     for text, y in zip(("现在", "输出", "上限", "设定", "下限"),
                                        (100, 120, 140, 160, 180)))
        self.assertEqual(find_ui_family(lines), ("FANUC", 0.99))
        self.assertEqual(find_page(lines), ("temperature", 0.98))

    def test_near_alias_does_not_fuzzy_match(self):
        lines = [{"text": "发那料", "conf": 0.99, "bbox": {"y_min": 0}}]
        self.assertEqual(find_ui_family(lines), ("unknown", 0.0))

    def test_no_temperature_structure_keeps_other_page(self):
        lines = [{"text": "保压", "conf": 0.99, "bbox": {"y_min": 0}},
                 {"text": "喷嘴/料筒", "conf": 0.98, "bbox": {"y_min": 20}}]
        self.assertEqual(find_page(lines)[0], "injection_metering")

    def test_low_temperature_holding_pair_beats_injection_statistics(self):
        lines = [{"text": "低温保持", "conf": 0.91, "bbox": {"y_min": 20}},
                 {"text": "低温保持解除", "conf": 0.96, "bbox": {"y_min": 40}},
                 {"text": "保压", "conf": 0.99, "bbox": {"y_min": 100}},
                 {"text": "计量", "conf": 0.99, "bbox": {"y_min": 120}}]
        self.assertEqual(find_page(lines), ("temperature", 0.96))


class ZizESTrailingDecimalTest(unittest.TestCase):
    def test_complete_cell_rescue_replaces_trailing_decimal(self):
        tpl = template("zizes.temperature.json")
        cols = [tpl["layout"]["column_x_centers"][str(i)] for i in range(1, 8)]
        oil = tpl["layout"]["column_x_centers"]["oil"]
        toks = [token(str(i), cols[i - 1], 0.20) for i in range(1, 8)]
        toks.append(token("油温", oil, 0.20))
        for label, y, value in (("当前", 0.30, "249."),
                                ("设定", 0.40, "250.0"),
                                ("控制", 0.50, "36.3")):
            toks.append(token(label, 0.05, y))
            toks.append(token(value, cols[0], y))
        toks.append(token("249.4", cols[0], 0.30, src="zizes_cell"))
        toks.extend((token("29.6", oil, 0.30), token("0.0", oil, 0.40)))

        result = extract_temperature(toks, tpl)
        self.assertEqual(result["fields"]["barrel_temperature_current_c"], [249.4])
        self.assertFalse(any(w.startswith("DECIMAL_TRUNCATED")
                             for w in result["warnings"]), result["warnings"])


if __name__ == "__main__":
    unittest.main()
