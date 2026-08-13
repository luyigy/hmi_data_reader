"""模温机独立设备温控器提取器（042 PLAN S04 新增）。

覆盖两种已登记 candidate Profile 布局（templates/ 同名模板）：

- OMRON_E5CC single_loop：AOLANTE/APM 温度循环控制机搭载的 Omron E5CC 单回路
  温控器；上行白色大数码管=PV（当前值），下行绿色小数码管=SV（设定值）。
- MOLD_THERMOREGULATOR pv_sv_decimal / pv_sv_integer：模具温度调节机双红 7 段
  数码管；上行=PV、下行=SV；layout_variant 按数码管实测是否带小数点判定
  （pv_sv_decimal/pv_sv_integer），经 detail.page_variant 透出给 contract。

取值规则（两布局共用）：
1. 数值候选来源（各坐标系独立，不跨系聚行）：受信来源 = base（主
   OCR/CLAHE 合并行）与 mt_full（原图全量 OCR），均为完整 det+rec 管线；
   旁车裁剪 rec-only（mt_cell 矫正图 / mt_cell_orig 原图）单独不足信，
   仅在两系结果一致（±0.5°C）时交叉采信。
2. 严格数值口径：^\d{1,3}(\.\d)?$ 且落入模板 sv_range；'500'（'50.0' 丢点）
   超界拒收，'8888'（关断残段）不符模式拒收，不猜值。
3. 同一来源按 y 聚行：恰好两行且行内无冲突 -> 上行 PV / 下行 SV；任一来源
   行数不为 2 或行内冲突即放弃该来源；全部来源不可用 ->
   VALUE_ROWS_MISSING/VALUE_ROWS_AMBIGUOUS 拒识，不猜值、不错位取舍。

输出契约字段：mold_temperature_set_c（SV 设定）与
mold_temperature_current_c（PV 当前，仅展示）。返回结构同其他家族提取器。
"""
from __future__ import annotations

import re

NUM_FULLMATCH = re.compile(r"^(\d{1,3}(?:\.\d)?)$")
# 同一显示行内 token 的 y 容差（归一化坐标）；PV/SV 两行间距实测约 0.025-0.035，
# 行内重复检出 token 几乎同 y（<0.01）——取值 0.012 以可靠分行
ROW_Y_TOL = 0.012


def _parse_value(text: str, lo: float, hi: float) -> float | None:
    m = NUM_FULLMATCH.match(text.strip())
    if not m:
        return None
    v = float(m.group(1))
    return v if lo <= v <= hi else None


def _value_rows(toks: list[dict], lo: float, hi: float) -> list[list[dict]]:
    """数值 token 按 y 聚行（仅含可解析数值的 token 参与）。"""
    cands = []
    for t in toks:
        v = _parse_value(t["text"], lo, hi)
        if v is not None:
            cands.append({"y": t["y"], "v": v, "text": t["text"]})
    cands.sort(key=lambda e: e["y"])
    rows: list[list[dict]] = []
    for e in cands:
        if rows and e["y"] - rows[-1][-1]["y"] <= ROW_Y_TOL:
            rows[-1].append(e)
        else:
            rows.append([e])
    return rows


def _extract_pv_sv(toks: list[dict], template: dict) -> dict:
    lo, hi = template["sv_range"]
    warnings: list[str] = []
    detail: dict = {}

    # 数值来源（坐标系不同，只在同一来源内聚行）：
    # 受信：base（主 OCR/CLAHE 合并行）、mt_full（原图全量 OCR）——完整 det+rec
    # 管线；旁车裁剪 rec-only（mt_cell 矫正图 / mt_cell_orig 原图）单独不足信，
    # 仅在两个旁车系结果一致时采信。
    src_map = {
        "base": [t for t in toks if t.get("src") not in ("mt_cell", "mt_cell_orig", "mt_full")],
        "mt_full": [t for t in toks if t.get("src") == "mt_full"],
        "mt_cell": [t for t in toks if t.get("src") == "mt_cell"],
        "mt_cell_orig": [t for t in toks if t.get("src") == "mt_cell_orig"],
    }
    rows_by_src = {k: _value_rows(v, lo, hi) for k, v in src_map.items()}
    detail["value_rows"] = {k: len(v) for k, v in rows_by_src.items()}

    def usable(rows) -> bool:
        return len(rows) == 2 and all(
            len({e["v"] for e in row}) == 1 for row in rows)

    rows, src_name = [], None
    for candidate in ("base", "mt_full"):
        if usable(rows_by_src[candidate]):
            rows, src_name = rows_by_src[candidate], candidate
            break
    if src_name is None:
        # 旁车交叉验证：两个坐标系的独立裁剪识别给出一致 (PV, SV) 才采信
        cell_rows = rows_by_src["mt_cell"]
        orig_rows = rows_by_src["mt_cell_orig"]
        if usable(cell_rows) and usable(orig_rows):
            pair_c = (cell_rows[0][0]["v"], cell_rows[1][0]["v"])
            pair_o = (orig_rows[0][0]["v"], orig_rows[1][0]["v"])
            if all(abs(a - b) <= 0.5 for a, b in zip(pair_c, pair_o)):
                rows, src_name = cell_rows, "mt_cell_xvalid"
    detail["value_source"] = src_name

    if src_name is None:
        n = max(len(v) for v in rows_by_src.values())
        code = "VALUE_ROWS_AMBIGUOUS" if n > 2 else "VALUE_ROWS_MISSING"
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"{code}({n})"],
                "detail": detail}
    pv_row, sv_row = rows[0], rows[1]

    pv = pv_row[0]["v"]
    sv = sv_row[0]["v"]
    detail["pv_text"] = pv_row[0]["text"]
    detail["sv_text"] = sv_row[0]["text"]
    fields = {
        "mold_temperature_set_c": sv,
        "mold_temperature_current_c": pv,
    }
    return {"fields": fields, "heater_columns": 0, "warnings": warnings,
            "detail": detail}


def extract_mold_temp_omron_e5cc(toks: list[dict], template: dict) -> dict:
    """Omron E5CC 单回路温控器（模温机搭载）。layout_variant 取模板 single_loop。"""
    return _extract_pv_sv(toks, template)


def extract_mold_temp_thermoregulator(toks: list[dict], template: dict) -> dict:
    """模具温度调节机双红数码管；按实测小数点判定 pv_sv_decimal/pv_sv_integer。"""
    result = _extract_pv_sv(toks, template)
    detail = result["detail"]
    texts = [detail.get("pv_text"), detail.get("sv_text")]
    texts = [t for t in texts if isinstance(t, str)]
    if texts:
        detail["page_variant"] = (
            "pv_sv_decimal" if any("." in t for t in texts) else "pv_sv_integer")
    return result
