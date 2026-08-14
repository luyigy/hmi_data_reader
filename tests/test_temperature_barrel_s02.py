"""042 PLAN S02 炮筒温度 Profile 校准回归测试。

聚焦三个根因修复（不依赖 GPU/OCR，直接喂数据化 token 流给提取器/分类器）：
1. B_AND_R 5 列变体（NZ/#1..#4，无 #5）：列对齐不错位，输出 6 元数组且 #5=None，
   不告 CELL_MISSING(col6)，heater_columns=5；带 #5 列头时仍按 6 列。
2. FANUC 现在行 N..H 5 值粘连 blob：料筒取前 4（N,B1,B2,B3）、H 取第 5，
   不再因旧的 best_v[-4:] 丢 N / 把 H 错填进 B3。
3. classify_ui「发那科 ↔ FANUC」显式别名：仅含「发那科」文本也分到 FANUC。
4. FANUC SET 行密度扫描失败但「设定」标签在：走 SET_ROW_LABEL_FALLBACK，不硬拒。
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from classify_ui import find_ui_family, UI_FAMILY_KEYWORDS
from extract_families.b_and_r import extract_temperature_b_and_r
from extract_families.fanuc import extract_temperature_fanuc

TPL_DIR = Path(__file__).resolve().parents[1] / "templates"


def _load_tpl(name):
    return json.loads((TPL_DIR / name).read_text())


def _tok(text, x, y, conf=0.95):
    return {"text": text, "x": float(x), "y": float(y), "conf": float(conf)}


# ----------------------------------------------------------- B_AND_R 5/6 列

def _br_token_set(cols, has_col5):
    """构造 B_AND_R 温度页 token 流。cols = [(label, [5 or 6 vals])]，
    列头含/不含 #5。行标签在 x=0.05，数值按 layout 列位放置。"""
    layout = _load_tpl("b_and_r.temperature.json")["layout"]["column_x_centers"]
    headers = ["NZ", "#1", "#2", "#3", "#4"] + (["#5"] if has_col5 else [])
    x_centers = [layout[h] for h in headers]
    toks = []
    # 列头行 y=0.26
    for h, cx in zip(headers, x_centers):
        toks.append(_tok(h, cx, 0.26))
    # 行标签 + 数值（5 行）
    row_defs = [
        ("际温度", "current", 0.30), ("定温度", "set", 0.34),
        ("高温偏差", "high", 0.38), ("低温偏差", "low", 0.42),
        ("加热输出", "control", 0.46),
    ]
    for lab, _rname, ry in row_defs:
        toks.append(_tok(lab, 0.05, ry))
    for (_lab, vals), ry in zip(cols, [0.30, 0.34, 0.38, 0.42, 0.46]):
        for v, cx in zip(vals, x_centers):
            if v is None:
                continue
            toks.append(_tok(f"{v}", cx, ry))
    # 保温温度（页底）
    toks.append(_tok("保温温度", 0.05, 0.86))
    toks.append(_tok("150.0", 0.20, 0.86))
    return toks


class BAndRColumnVariantTest(unittest.TestCase):
    TPL = _load_tpl("b_and_r.temperature.json")

    def test_five_column_variant_no_shift(self):
        """5 列变体（无 #5）：6 元数组、#5=None、不告 col6 缺格、heater_columns=5。"""
        vals = [250.0, 255.0, 255.0, 245.0, 225.0]  # NZ..#4
        cols = [
            ("current", [249.9, 255.3, 255.1, 244.9, 224.8]),
            ("set", vals),
            ("high", [30.0, 30.0, 30.0, 25.0, 35.0]),
            ("low", [20.0, 20.0, 20.0, 20.0, 20.0]),
            ("control", [24.4, 42.0, 8.1, 10.6, 20.6]),
        ]
        toks = _br_token_set(cols, has_col5=False)
        res = extract_temperature_b_and_r(toks, self.TPL)
        self.assertEqual(res["heater_columns"], 5, res["warnings"])
        setv = res["fields"]["barrel_temperature_set_c"]
        self.assertEqual(len(setv), 6)
        self.assertEqual(setv[:5], vals)
        self.assertIsNone(setv[5])  # #5 物理不存在 -> None
        # 不应出现 col6 缺格告警（#5 不存在 != 缺格）
        self.assertFalse(any("col6" in w for w in res["warnings"]),
                         f"unexpected col6 missing: {res['warnings']}")

    def test_six_column_with_col5_header(self):
        """带 #5 列头时仍按 6 列提取（回归保护）。"""
        vals = [250.0, 255.0, 255.0, 245.0, 225.0, 210.0]
        cols = [
            ("current", vals[:]),
            ("set", vals[:]),
            ("high", [30.0, 30.0, 30.0, 25.0, 35.0, 30.0]),
            ("low", [20.0, 20.0, 20.0, 20.0, 20.0, 20.0]),
            ("control", [24.4, 42.0, 8.1, 10.6, 20.6, 15.0]),
        ]
        toks = _br_token_set(cols, has_col5=True)
        res = extract_temperature_b_and_r(toks, self.TPL)
        self.assertEqual(res["heater_columns"], 6, res["warnings"])
        self.assertEqual(res["fields"]["barrel_temperature_set_c"], vals)

    def test_low_deviation_ocr_alias(self):
        """真实样本将“低温偏差”读成“低湿偏差”时仍识别该行。"""
        vals = [250.0, 255.0, 255.0, 245.0, 225.0, 210.0]
        rows = [(name, vals) for name in ("current", "set", "high", "low", "control")]
        toks = _br_token_set(rows, has_col5=True)
        next(t for t in toks if t["text"] == "低温偏差")["text"] = "低湿偏差"
        res = extract_temperature_b_and_r(toks, self.TPL)
        self.assertIsNotNone(res["fields"], res["warnings"])


# ----------------------------------------------------------- FANUC 现在行粘连

def _fanuc_token_set(now_blob_text):
    """构造 FANUC 温度页 token 流：现在行用给定粘连 blob 文本。"""
    toks = [
        _tok("喷嘴/料筒", 0.10, 0.12),
        _tok("现在", 0.08, 0.34),
        _tok("输出", 0.08, 0.40),
        _tok("上限", 0.08, 0.52),
        _tok("设定", 0.08, 0.58),
        _tok("下限", 0.08, 0.64),
        _tok("低温保持", 0.40, 0.15),
        # 设定行（4 料筒 + H），用于 find_set_y 密度扫描命中
        _tok("290.0", 0.30, 0.58), _tok("285.0", 0.40, 0.58),
        _tok("275.0", 0.50, 0.58), _tok("270.0", 0.60, 0.58),
        # 上限/下限行
        _tok("10.0", 0.30, 0.52), _tok("10.0", 0.40, 0.52),
        _tok("10.0", 0.50, 0.52), _tok("15.0", 0.60, 0.52),
        _tok("10.0", 0.30, 0.64), _tok("10.0", 0.40, 0.64),
        _tok("10.0", 0.50, 0.64), _tok("15.0", 0.60, 0.64),
        # 输出行
        _tok("36.5", 0.30, 0.40), _tok("12.6", 0.40, 0.40),
        _tok("6.3", 0.50, 0.40), _tok("52.4", 0.60, 0.40),
        # 现在行：N..H 5 值粘连成一个 blob
        _tok(now_blob_text, 0.45, 0.34, conf=0.88),
    ]
    return toks


class FanucCurrentRowGluedTest(unittest.TestCase):
    TPL = _load_tpl("fanuc.temperature.json")

    def test_five_value_blob_keeps_nozzle(self):
        """N,B1,B2,B3,H 全粘进一个 blob：料筒取前 4，H 取第 5（旧逻辑丢 N）。"""
        toks = _fanuc_token_set("289.9 285.0 274.9 269.8 45.4")
        res = extract_temperature_fanuc(toks, self.TPL)
        cur = res["fields"]["barrel_temperature_current_c"]
        self.assertEqual(cur, [289.9, 285.0, 274.9, 269.8], res["warnings"])
        # H（料口实际）取第 5 个值
        self.assertEqual(res["fields"]["drop_port_temperature_current_c"], 45.4)

    def test_four_value_blob_no_h_glued(self):
        """仅 N..B3 粘连（4 值）、H 独立：料筒仍为该 4 值，H 取 blob 右侧单值。"""
        toks = _fanuc_token_set("289.9 285.0 274.9 269.8")
        toks.append(_tok("45.4", 0.66, 0.34))  # H 独立 token
        res = extract_temperature_fanuc(toks, self.TPL)
        cur = res["fields"]["barrel_temperature_current_c"]
        self.assertEqual(cur, [289.9, 285.0, 274.9, 269.8])


class FanucSetRowLabelFallbackTest(unittest.TestCase):
    """SET 行密度扫描失败但「设定」标签在 -> SET_ROW_LABEL_FALLBACK，不硬拒。"""
    TPL = _load_tpl("fanuc.temperature.json")

    def test_label_fallback_avoids_set_row_not_found(self):
        toks = [
            _tok("现在", 0.08, 0.34), _tok("输出", 0.08, 0.40),
            _tok("上限", 0.08, 0.52), _tok("设定", 0.08, 0.58),
            _tok("下限", 0.08, 0.64), _tok("低温保持", 0.40, 0.15),
            # 设定行只有 2 个 ≥100 的值（密度扫描需 ≥3 -> 失败 -> 退标签）
            _tok("275.0", 0.50, 0.58), _tok("270.0", 0.60, 0.58),
            # 上限/下限行
            _tok("10.0", 0.30, 0.52), _tok("10.0", 0.40, 0.52),
            _tok("15.0", 0.60, 0.52),
            _tok("10.0", 0.30, 0.64), _tok("10.0", 0.40, 0.64),
            _tok("15.0", 0.60, 0.64),
        ]
        res = extract_temperature_fanuc(toks, self.TPL)
        # 不应整页 reject：fields 非 None，走标签兜底而非 SET_ROW_NOT_FOUND
        self.assertIsNotNone(res["fields"])
        self.assertTrue(any("SET_ROW_LABEL_FALLBACK" in w for w in res["warnings"]),
                        f"expected label fallback warn: {res['warnings']}")
        self.assertFalse(any("SET_ROW_NOT_FOUND" in w for w in res["warnings"]))


# ----------------------------------------------------------- 发那科 ↔ FANUC

class FanucChineseAliasTest(unittest.TestCase):
    def test_fakemake_chinese_alias_classifies_fanuc(self):
        """仅含「发那科」中文品牌名也分到 FANUC（显式别名，不靠模糊字符）。"""
        lines = [{"text": "发那科", "conf": 0.99,
                  "bbox": {"x_min": 0, "y_min": 0, "x_max": 10, "y_max": 10}}]
        fam, conf = find_ui_family(lines)
        self.assertEqual(fam, "FANUC")
        self.assertGreater(conf, 0.0)

    def test_alias_present_in_keyword_table(self):
        self.assertIn("发那科", UI_FAMILY_KEYWORDS["FANUC"])


if __name__ == "__main__":
    unittest.main()
