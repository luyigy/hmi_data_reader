"""042 S04 模温机契约与 Profile 聚焦回归。

覆盖：
- 模温设备家族（OMRON_E5CC/MOLD_THERMOREGULATOR）无 temperature 模板时，
  route_page 的非温度页锚点循环仍生效（不再被 find_page「温度/冷却」误分）；
- fanuc.mold_temp 家族指纹收窄为双组 AND，独立调节机不再误判 FANUC；
- 模温提取器：PV/SV 双行取值、旁车优先不跨坐标系聚行、缺行拒识、
  超界（'500' 丢点）与残段（'8888'）拒收、变体小数点判定；
- contract 对 mold_temp 从 detail.page_variant 解析 layout_variant；
- 输出仅契约字段 mold_temperature_set_c / mold_temperature_current_c。
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from contract import attach_contract
from extract_families.fanuc_mold_temp import extract_mold_temp_fanuc
from extract_families.mold_temp_devices import (
    extract_mold_temp_omron_e5cc, extract_mold_temp_thermoregulator)
from extract_fields import detect_family_from_templates, route_page


def template(name):
    return json.loads((ROOT / "templates" / name).read_text(encoding="utf-8"))


def line(text, y_min=0.0):
    return {"text": text, "conf": 0.99,
            "bbox": {"x_min": 0.0, "y_min": y_min, "x_max": 1.0, "y_max": y_min + 1.0}}


def cell(text, y):
    return {"text": text, "x": 0.5, "y": y, "conf": 0.99, "src": "mt_cell"}


def base_tok(text, y):
    return {"text": text, "x": 0.5, "y": y, "conf": 0.99, "src": None}


class MoldTempPageRoutingTest(unittest.TestCase):
    """独立设备家族没有 temperature 模板时，非温度页锚点循环仍须生效。"""

    OMRON_TEXTS = ["奥兰特精机", "AOLANTE MACHINERY", "温度循环控制机",
                   "TEMPCIRCULATION. CONTROLLER", "冷却", "加热"]

    def test_omron_panel_routes_to_mold_temp_not_barrel_temperature(self):
        fam = detect_family_from_templates(
            [line(t) for t in self.OMRON_TEXTS], ROOT / "templates")
        self.assertEqual(fam, "OMRON_E5CC")
        page, src = route_page("raw_upload", [line(t) for t in self.OMRON_TEXTS],
                               fam, ROOT / "templates")
        self.assertEqual((page, src), ("mold_temp", "template_anchors"))

    def test_thermoregulator_panel_routes_to_mold_temp(self):
        texts = ["模具温度调节机", "MOLD-THERMOREGULATOR", "故障代码 ERROR CODE"]
        fam = detect_family_from_templates(
            [line(t) for t in texts], ROOT / "templates")
        self.assertEqual(fam, "MOLD_THERMOREGULATOR")
        page, _ = route_page("raw_upload", [line(t) for t in texts],
                             fam, ROOT / "templates")
        self.assertEqual(page, "mold_temp")

    def test_thermoregulator_no_longer_misrouted_to_fanuc(self):
        # 042 S01 实测失败模式：独立调节机含「模具温度调节机」被 fanuc.mold_temp
        # 单组指纹劫走；收窄为双组 AND 后无 FANUC 品牌词不命中
        texts = ["模具温度调节机", "MOLD-THERMOREGULATOR", "故障代码 ERROR CODE"]
        fam = detect_family_from_templates(
            [line(t) for t in texts], ROOT / "templates")
        self.assertNotEqual(fam, "FANUC")

    def test_fanuc_screen_with_brand_still_matches_fanuc_fallback(self):
        texts = ["模具温度调节机", "ROBOSHOT"]
        fam = detect_family_from_templates(
            [line(t) for t in texts], ROOT / "templates")
        self.assertEqual(fam, "FANUC")


class MoldTempExtractorTest(unittest.TestCase):
    def test_omron_cells_only_rejected_without_trusted_source(self):
        # 旁车裁剪 rec-only 单独不足信（实测 '140'/'88' 残段误读），须拒识
        toks = [cell("40", 0.29), cell("40", 0.33)]
        result = extract_mold_temp_omron_e5cc(toks, template("omron_e5cc.mold_temp.json"))
        self.assertIsNone(result["fields"])

    def test_cells_cross_validated_across_frames_accepted(self):
        toks = [cell("40", 0.29), cell("40", 0.33),
                {**cell("40", 0.225), "src": "mt_cell_orig"},
                {**cell("40", 0.259), "src": "mt_cell_orig"}]
        result = extract_mold_temp_omron_e5cc(toks, template("omron_e5cc.mold_temp.json"))
        self.assertEqual(result["detail"]["value_source"], "mt_cell_xvalid")
        self.assertEqual(result["fields"], {
            "mold_temperature_set_c": 40.0, "mold_temperature_current_c": 40.0})

    def test_cells_disagreeing_across_frames_rejected(self):
        toks = [cell("140", 0.29), cell("88", 0.33),
                {**cell("40", 0.225), "src": "mt_cell_orig"},
                {**cell("40", 0.259), "src": "mt_cell_orig"}]
        result = extract_mold_temp_omron_e5cc(toks, template("omron_e5cc.mold_temp.json"))
        self.assertIsNone(result["fields"])

    def test_base_tokens_used_when_no_cells(self):
        toks = [base_tok("90.0", 0.48), base_tok("90.0", 0.52)]
        result = extract_mold_temp_thermoregulator(
            toks, template("mold_thermoregulator.mold_temp.json"))
        self.assertEqual(result["fields"]["mold_temperature_set_c"], 90.0)
        self.assertEqual(result["detail"]["page_variant"], "pv_sv_decimal")

    def test_mt_full_orig_ocr_trusted(self):
        toks = [{**cell("68", 0.44), "src": "mt_full"},
                {**cell("68", 0.50), "src": "mt_full"}]
        result = extract_mold_temp_omron_e5cc(toks, template("omron_e5cc.mold_temp.json"))
        self.assertEqual(result["detail"]["value_source"], "mt_full")
        self.assertEqual(result["fields"]["mold_temperature_set_c"], 68.0)

    def test_integer_variant_detected(self):
        toks = [base_tok("30", 0.48), base_tok("30", 0.52)]
        result = extract_mold_temp_thermoregulator(
            toks, template("mold_thermoregulator.mold_temp.json"))
        self.assertEqual(result["detail"]["page_variant"], "pv_sv_integer")

    def test_single_row_rejected(self):
        result = extract_mold_temp_omron_e5cc([base_tok("68", 0.30)],
                                              template("omron_e5cc.mold_temp.json"))
        self.assertIsNone(result["fields"])
        self.assertTrue(any(w.startswith("VALUE_ROWS_MISSING") for w in result["warnings"]))

    def test_out_of_range_and_ghost_segments_rejected(self):
        # '500'（'50.0' 丢点）超 sv_range；'8888' 残段不符数值模式
        toks = [base_tok("500", 0.30), base_tok("8888", 0.35)]
        result = extract_mold_temp_omron_e5cc(toks, template("omron_e5cc.mold_temp.json"))
        self.assertIsNone(result["fields"])

    def test_cells_and_base_not_mixed_across_frames(self):
        # 旁车仅 1 行时回退主 OCR 整体聚行，不与旁车跨坐标系拼行
        toks = [cell("45", 0.10), base_tok("45", 0.60), base_tok("45", 0.66)]
        result = extract_mold_temp_omron_e5cc(toks, template("omron_e5cc.mold_temp.json"))
        self.assertEqual(result["detail"]["value_source"], "base")
        self.assertEqual(result["fields"]["mold_temperature_set_c"], 45.0)


class MoldTempContractTest(unittest.TestCase):
    def test_variant_from_detail_for_thermoregulator(self):
        result = {
            "controller_family": "MOLD_THERMOREGULATOR", "page_type": "mold_temp",
            "fields": {"mold_temperature_set_c": 90.0, "mold_temperature_current_c": 90.0},
            "extraction_detail": {"page_variant": "pv_sv_decimal"},
        }
        attach_contract(result)
        self.assertEqual(result["profile_id"],
                         "mold_thermoregulator.mold_temp.pv_sv_decimal")
        self.assertEqual(result["profile_status"], "candidate")
        self.assertEqual(
            result["field_meta"]["mold_temperature_set_c"]["web_target"],
            "mold_zone_temperature_set")

    def test_template_variant_for_omron(self):
        result = {
            "controller_family": "OMRON_E5CC", "page_type": "mold_temp",
            "fields": {"mold_temperature_set_c": 40.0, "mold_temperature_current_c": 40.0},
            "extraction_detail": {},
        }
        attach_contract(result)
        self.assertEqual(result["profile_id"], "omron_e5cc.mold_temp.single_loop")
        self.assertEqual(result["profile_status"], "candidate")

    def test_fanuc_extractor_emits_contract_field(self):
        result = extract_mold_temp_fanuc([base_tok("40.0", 0.5)],
                                         template("fanuc.mold_temp.json"))
        self.assertIn("mold_temperature_set_c", result["fields"])
        self.assertNotIn("set_temperature_c", result["fields"])


if __name__ == "__main__":
    unittest.main()
