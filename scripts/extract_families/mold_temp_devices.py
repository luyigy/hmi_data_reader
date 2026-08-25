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
   但两个旁车系给出唯一一致（±0.5°C）结果时优先于整图来源——整图 OCR
   会把倾斜显示的未点亮残段误读（如 100.1→100.8）；无唯一交叉结果时才
   回退受信整图来源。
2. 严格数值口径：^\d{1,3}(\.\d)?$ 且落入模板 sv_range；'500'（'50.0' 丢点）
   超界拒收，'8888'（关断残段）不符模式拒收，不猜值。
3. 同一来源按 y 聚行：恰好两行且行内无冲突 -> 上行 PV / 下行 SV；旁车存在
   额外噪声行时，仅接受两个坐标系唯一一致的相邻双行；全部来源不可用 ->
   VALUE_ROWS_MISSING/VALUE_ROWS_AMBIGUOUS 拒识，不猜值、不错位取舍。

输出契约字段：mold_temperature_set_c（SV 设定）与
mold_temperature_current_c（PV 当前，仅展示）。返回结构同其他家族提取器。
"""
from __future__ import annotations

import re

NUM_FULLMATCH = re.compile(r"^(\d{1,3}(?:\.\d)?)$")
LCD_SET_SUFFIX = re.compile(r"^(\d{1,3}(?:\.\d)?)(?:S(?:E|5)?T|5T)$", re.I)
LCD_SET_OVERREAD = re.compile(r"^(\d{1,3}\.\d)\d{1,2}$")
# 同一显示行内 token 的 y 容差（归一化坐标）；PV/SV 两行间距实测约 0.025-0.035，
# 行内重复检出 token 几乎同 y（<0.01）——取值 0.012 以可靠分行
ROW_Y_TOL = 0.012


def _parse_value(text: str, lo: float, hi: float) -> float | None:
    m = NUM_FULLMATCH.match(text.strip())
    if not m:
        return None
    v = float(m.group(1))
    return v if lo <= v <= hi else None


def is_lcd_pv_set(lines: list[dict], lo: float = 5, hi: float = 200) -> bool:
    """未知家族旁车是否给出上下排列的 PV 纯数值 + SET 粘连数值。"""
    texts = [str(line.get("text") or "").strip() for line in lines]
    joined = "".join(re.sub(r"[^A-Z]", "", text.upper()) for text in texts)
    if "CHILL" in joined and ("INDUSTR" in joined or "USTR" in joined):
        return True
    pure = []
    set_rows = []
    for line in lines:
        text = str(line.get("text") or "").strip().upper()
        exact = NUM_FULLMATCH.match(text)
        match = LCD_SET_SUFFIX.match(text) or LCD_SET_OVERREAD.match(text)
        value_match = match or exact
        if not value_match or not lo <= float(value_match.group(1)) <= hi:
            continue
        box = line.get("bbox") or {}
        y = (float(box.get("y_min", 0)) + float(box.get("y_max", 0))) / 2
        (set_rows if match else pure).append(y)
    return any(pv_y < set_y for pv_y in pure for set_y in set_rows)


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

    def pairs(rows):
        return [(rows[i:i + 2], tuple(next(iter({e["v"] for e in row}))
                                      for row in rows[i:i + 2]))
                for i in range(len(rows) - 1)
                if all(len({e["v"] for e in row}) == 1 for row in rows[i:i + 2])]

    # 两个坐标系的独立显示带 OCR 一致时，优先于会把未点亮段
    # 误读为 8 的整图 OCR；无唯一交叉结果时才回退受信整图来源。
    cell_rows = rows_by_src["mt_cell"]
    orig_rows = rows_by_src["mt_cell_orig"]
    matches = [(pair_c, values_c) for pair_c, values_c in pairs(cell_rows)
               for _, values_o in pairs(orig_rows)
               if all(abs(a - b) <= 0.5 for a, b in zip(values_c, values_o))]
    distinct = []
    for pair_c, values_c in matches:
        if not any(all(abs(a - b) <= 0.5 for a, b in zip(values_c, prior))
                   for prior in distinct):
            distinct.append(values_c)
    rows, src_name = (matches[0][0], "mt_cell_xvalid") if len(distinct) == 1 else ([], None)
    if src_name is None:
        for candidate in ("base", "mt_full"):
            if usable(rows_by_src[candidate]):
                rows, src_name = rows_by_src[candidate], candidate
                break
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
    # 完整 OCR 已给出双行、但两套独立 cell OCR 都只看清同一行时，无法仅凭
    # 单行判断它是 PV 还是 SV。若该共识值不能同时解释完整 OCR 的两行，说明
    # 来源互相矛盾；安全拒识，避免把七段残影（如 100.1 -> 100.8）自动入库。
    if src_name in ("base", "mt_full"):
        cell_rows = rows_by_src["mt_cell"]
        orig_rows = rows_by_src["mt_cell_orig"]
        if len(cell_rows) == len(orig_rows) == 1:
            cell_values = {e["v"] for e in cell_rows[0]}
            orig_values = {e["v"] for e in orig_rows[0]}
            if len(cell_values) == len(orig_values) == 1:
                cell_value = next(iter(cell_values))
                orig_value = next(iter(orig_values))
                if (abs(cell_value - orig_value) <= 0.5
                        and not all(abs(cell_value - v) <= 0.5 for v in (pv, sv))):
                    detail["value_conflict"] = {
                        "trusted": [pv, sv], "cell_consensus": cell_value}
                    return {"fields": None, "heater_columns": 0,
                            "warnings": warnings + ["VALUE_SOURCE_CONFLICT"],
                            "detail": detail}
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


def extract_mold_temp_industrial_chiller(toks: list[dict], template: dict) -> dict:
    """工业冷水机 LCD：PV 大字在上，SET 小字在下。"""
    normalized = []
    for tok in toks:
        match = LCD_SET_SUFFIX.match(tok["text"].strip()) \
            or LCD_SET_OVERREAD.match(tok["text"].strip())
        normalized.append({**tok, "text": match.group(1)} if match else tok)
    result = _extract_pv_sv(normalized, template)
    result["detail"]["page_variant"] = "lcd_pv_set"
    return result
