"""S4 字段提取：controller+page 路由 → 归一化模板 → 屏幕归一化坐标提取 → 校验 → status。

提取链路保持 OCR + 模板（PLAN 硬约束：VLM 不进入提取链路，防真值/提取同源循环论证）。

输入（S4 薄切片产物，均在 output/rectified/ 下）：
- <stem>.rectify.json  — rectify.py 的屏幕 meta（screen_size / 检测方法 / warnings）
- <stem>.ocr.json      — 对矫正图跑的 PaddleOCR 原始输出（token 级 bbox）

路由（controller_family，按优先级）：
1. S2 record 级聚合报告（output/record_classify_report.json，record key 命中且非 unknown）
2. S1 机器先验（ground_truth/machine_labels.json，品牌_机台号 前缀 + records 列表命中）
3. 单图 classify_ui.find_ui_family 兜底
页面：classify_ui.find_page；兜底文件名含 "炮筒" -> temperature。
路由到 (family, page) 后加载 templates/<family.lower()>.<page>.json；无模板 -> reject。

提取（坐标均为屏幕归一化 x/screen_width, y/screen_height）：
- ZizES：数字列头线性拟合列位 + y 聚类出 当前/设定/控制 3 行（详见 extract_temperature）。
- TACT：区段中文列头（喷嘴/筒头/前部/中部/后部/落下口）实测列位 + 行标签
  （设定温度/现在温度/控制输出/保温温度）直接锚定 4 行（详见 extract_temperature_tact）。
- KEBA（伯乐灰 UI）：设定温度/温度设置 + 上偏差/下偏差 行标签锚定行带，段数动态
  （5/6，设定行数值定列位 + 缺列插补/前推），图形行取实际温度与下料口温度
  （详见 extract_temperature_keba）。
- B_AND_R（伯乐蓝 UI）：实际温度/设定温度/高、低温偏差/加热输出 行标签锚定 5 行，
  6 列（NZ/#1~#5）按数值 x 聚类（详见 extract_temperature_b_and_r）。
各家族共用：单元格 conf/范围/current vs set 一致性校验，任何 warning -> status != ok。
TACT/KEBA/B_AND_R 提取前合并 CLAHE 变体 OCR（merge_variant_lines 保守规则）。
家族路由兜底：record/机台先验与单图关键词分类均失败时，按模板
family_detect_groups 在合并行上判族（detect_family_from_templates）。

status 语义：ok = 全部字段提取且无 warning；review = 有提取结果但有 warning；
reject = 路由无模板 / 行或列结构识别失败 / 无有效字段。

用法：
    python scripts/extract_fields.py --all --rectified-dir output/rectified --output-dir output/extracted
    python scripts/extract_fields.py <stem>... --output-dir output/extracted
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from classify_ui import find_page, find_ui_family  # noqa: E402
from contract import attach_contract  # noqa: E402
from extract_generic import extract_generic  # noqa: E402
from extract_families.common import _anchor_hits, _fit_slope, norm_cjk  # noqa: E402

TEMPLATES_DIR = Path("templates")
RECORD_REPORT = Path("output/record_classify_report.json")
MACHINE_LABELS = Path("ground_truth/machine_labels.json")

NUM_RE = re.compile(r"\d+\.?\d*")
DIGIT_HEADER_RE = re.compile(r"[1-9]")
# record key 候选：v2_ 前缀可选（output/json 的 OCR 名带 v2_，原始图名不带）
REC_KEY_RE = re.compile(r"^(?:v2_)?(.+?_rec\d+?)_")
REC_V1_RE = re.compile(r"^(?:v2_)?(.+?)_t\d+_")


def record_key_candidates(stem: str) -> list[str]:
    """stem -> record 聚合报告里的可能 key（带/不带 v2_ 前缀都试）。"""
    m = REC_KEY_RE.match(stem) or REC_V1_RE.match(stem)
    if not m:
        return []
    base = m.group(1)
    return [f"v2_{base}", base]


# ---------------------------------------------------------------- 路由

def _anchor_match(anchor, text: str) -> bool:
    """锚点（字符串或候选字符串列表）是否为 text 的子串。"""
    return any(a in text for a in (anchor if isinstance(anchor, list) else [anchor]))


def detect_family_from_templates(lines: list[dict], templates_dir: Path) -> str | None:
    """模板 family_detect_groups 判族（最后兜底）：每个 group 内任一候选命中即该组命中，
    全部组命中则判为该模板的 ui_family。仅在 record/机台/单图分类全部失败时调用，
    不影响 ZizES/TACT 等既有路由。
    039_FIX：glob 从 *.temperature.json 放宽到全部模板——EST 等只有注射页模板的
    家族此前永远无法走该兜底（整族 unknown 误拒）。各组按模板文件名序取先命中者。"""
    texts = [l["text"] for l in lines]
    for tpl_path in sorted(Path(templates_dir).glob("*.json")):
        try:
            tpl = json.loads(tpl_path.read_text())
        except Exception:
            continue
        groups = tpl.get("family_detect_groups")
        if not groups:
            continue
        if all(_anchor_hits(g, texts) for g in groups):
            return tpl.get("ui_family")
    return None


def route_family(stem: str, lines: list[dict],
                 record_report: dict | None, machine_labels: dict | None) -> tuple[str, str]:
    """返回 (controller_family, source)。"""
    # 1. S2 record 级聚合
    if record_report:
        for key in record_key_candidates(stem):
            entry = record_report.get("records", {}).get(key)
            if entry and entry.get("controller_family") not in (None, "unknown"):
                return entry["controller_family"], "record_report"
    # 2. S1 机器先验
    if machine_labels:
        for machine_id, info in machine_labels.get("machines", {}).items():
            parts = machine_id.split("_")
            if len(parts) >= 2 and f"{parts[0]}_{parts[1]}" in stem:
                fam = info.get("controller_family", "")
                if fam and fam != "UNKNOWN":
                    return fam, "machine_labels"
    # 3. 单图兜底
    fam, _ = find_ui_family(lines)
    return fam, "per_image_classify"


def route_page(stem: str, lines: list[dict], family: str,
               templates_dir: Path = TEMPLATES_DIR,
               extra_anchor_lines: list[dict] | None = None) -> tuple[str, str]:
    """页面路由：结构锚点优先（该家族温度页模板的 油温列头 + 设定/控制行锚点
    同时在场），其次 classify_ui.find_page，最后文件名兜底。

    find_page 会被页内 '设定°C'/'控制%' 行标签与底部 Tab 干扰（实测 rec12 误判
    settings），所以温度页模板锚点命中时直接判 temperature。

    extra_anchor_lines（042 S04）：模温机旁车等附加 OCR 行，仅参与模板锚点
    文本匹配，不进 find_page 的位置启发（坐标系可能不同）。"""
    tpl = load_template(family, "temperature", templates_dir) if family != "unknown" else None
    texts = [l["text"] for l in lines + (extra_anchor_lines or [])]
    if tpl:
        anchors = tpl["row_anchors"]
        # 模板可声明自己的页面检测锚点（TACT 无油温列头）；缺省保持 ZizES 口径
        # 锚点值为字符串或候选列表（KEBA 设定温度/温度设置 双子变体）
        keys = tpl.get("page_detect_anchors", ["oil_header", "set", "control"])
        if all(_anchor_hits(anchors[k], texts) for k in keys):
            return "temperature", "template_anchors"
        # 083 S07：模板可再声明备选锚点组（page_detect_anchor_groups，任一组
        # 全命中即判温度页）——TACT 温度页五段变体的行标签（设定温度/现在温度/
        # 控制输出）可能被 OCR 整列丢失，但落下口列头仍在（落下口仅出现于
        # 温度页，全仓 OCR 语料无注射/其它页命中）。
        for group in tpl.get("page_detect_anchor_groups", []):
            if group and all(_anchor_hits(anchors[k], texts) for k in group):
                return "temperature", "template_anchors"
    if family != "unknown":
        # 非温度页模板锚点路由（049 B2 molding_monitor 等）：全部 page_detect_anchors
        # 在场即判该页（锚点设计成跨页互斥）
        # 042 S04：模温机等独立设备家族没有 temperature 模板——锚点循环移出
        # if tpl 分支，否则设备面板的「温度循环控制机」「冷却」字样会被
        # find_page 误分为注塑机 temperature/storage_cooling 后 NO_TEMPLATE 误拒。
        for tp in sorted(templates_dir.glob(f"{family.lower()}.*.json")):
            page_name = tp.stem.split(".", 1)[1]
            if page_name == "temperature":
                continue
            t2 = json.loads(tp.read_text())
            anchors2 = t2.get("page_detect_anchors")
            if anchors2 and all(_anchor_hits(a, texts) for a in anchors2):
                return page_name, "template_anchors"
    page, _ = find_page(lines)
    if page != "unknown":
        return page, "find_page"
    if "炮筒" in stem:
        return "temperature", "filename_hint"
    return "unknown", "none"


def load_template(family: str, page: str, templates_dir: Path = TEMPLATES_DIR) -> dict | None:
    path = templates_dir / f"{family.lower()}.{page}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text())


# ---------------------------------------------------------------- 提取

def norm_tokens(ocr_data: dict, screen_size: list[int]) -> list[dict]:
    """OCR 原始 lines -> 屏幕归一化坐标的 token 列表。"""
    W, H = screen_size
    toks = []
    for l in ocr_data.get("lines", []):
        b = l["bbox"]
        toks.append({
            "text": l["text"],
            "conf": float(l["conf"]),
            "x": ((b["x_min"] + b["x_max"]) / 2) / W,
            "y": ((b["y_min"] + b["y_max"]) / 2) / H,
            "x0": b["x_min"] / W,
            "x1": b["x_max"] / W,
            "src": l.get("_src"),
        })
    return toks


def detect_columns(toks: list[dict], template: dict) -> tuple[list[float] | None, float | None, list[str]]:
    """实测列位：返回 (7 个料筒列 x 中心或 None, 油温列 x 或 None, warnings)。"""
    warnings = []
    oil = [t for t in toks if template["row_anchors"]["oil_header"] in t["text"]]
    if not oil:
        warnings.append("OIL_HEADER_NOT_FOUND")
        return None, None, warnings
    oil_t = oil[0]
    digits = {}
    for t in toks:
        if DIGIT_HEADER_RE.fullmatch(t["text"]) and abs(t["y"] - oil_t["y"]) < 0.03:
            digits[int(t["text"])] = t
    if len(digits) < 4:
        warnings.append(f"HEADER_DIGITS_INSUFFICIENT({len(digits)})")
        return None, oil_t["x"], warnings
    # 线性拟合 x = a*col + b，补齐缺失列头（列头 1 常被漏检）
    idx = sorted(digits)
    n = len(idx)
    mx = sum(idx) / n
    my = sum(digits[i]["x"] for i in idx) / n
    a = sum((i - mx) * (digits[i]["x"] - my) for i in idx) / sum((i - mx) ** 2 for i in idx)
    b = my - a * mx
    # 合理性校验：列距与模板平均列距偏差 > 30% 则回退模板
    if abs(a - template["layout"]["column_spacing_avg"]) > 0.3 * template["layout"]["column_spacing_avg"]:
        warnings.append(f"HEADER_SPACING_ABNORMAL({a:.4f})")
        return None, oil_t["x"], warnings
    return [a * i + b for i in range(1, 8)], oil_t["x"], warnings


def deskew_slope(toks: list[dict], oil_t_text: str) -> float:
    """用列头行（数字 + 油温）拟合 y = k*(x-0.5) + c 的斜率 k，用于去斜。"""
    header = [t for t in toks
              if (DIGIT_HEADER_RE.fullmatch(t["text"]) or oil_t_text in t["text"])]
    if len(header) < 3:
        return 0.0
    ys = [t["y"] for t in header]
    hy = sum(ys) / len(ys)
    header = [t for t in header if abs(t["y"] - hy) < 0.03]
    if len(header) < 3:
        return 0.0
    mx = sum(t["x"] for t in header) / len(header)
    my = sum(t["y"] for t in header) / len(header)
    denom = sum((t["x"] - mx) ** 2 for t in header)
    if denom < 1e-6:
        return 0.0
    return sum((t["x"] - mx) * (t["y"] - my) for t in header) / denom


def extract_temperature(toks: list[dict], template: dict) -> dict:
    """ZizES 温度页提取主逻辑。返回 {fields, heater_columns, warnings, detail}。"""
    warnings: list[str] = []
    anchors = template["row_anchors"]
    layout = template["layout"]
    rules = template["validation_rules"]
    disabled_marks = set(template["heater_columns"]["disabled_marks"])

    # 列位（实测优先，模板兜底）
    cols, oil_x, col_warns = detect_columns(toks, template)
    warnings.extend(col_warns)
    if cols is None:
        warnings.append("TEMPLATE_COLUMNS_FALLBACK")
    if oil_x is None:
        oil_x = layout["column_x_centers"]["oil"]
    if cols is not None:
        spacing = cols[1] - cols[0]
        col_tol = spacing / 2

    # 去斜 + 行锚点
    k = deskew_slope(toks, anchors["oil_header"])
    for t in toks:
        t["y2"] = t["y"] - k * (t["x"] - 0.5)
    set_anchor = [t for t in toks if anchors["set"] in t["text"]]
    ctl_anchor = [t for t in toks if anchors["control"] in t["text"]]
    oil_anchor = [t for t in toks if anchors["oil_header"] in t["text"]]
    if not (set_anchor and ctl_anchor and oil_anchor):
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["ROW_ANCHORS_NOT_FOUND"], "detail": {}}
    header_y = oil_anchor[0]["y2"]
    set_y = set_anchor[0]["y2"]
    ctl_y = ctl_anchor[0]["y2"]
    row_tol = layout["row_y_tolerance"]

    # 数据区 token：去斜后落在 (列头行, 控制行+tol] 内
    band = [t for t in toks if header_y + 0.01 < t["y2"] <= ctl_y + row_tol]
    label_tokens = [t for t in band if anchors["set"] in t["text"] or anchors["control"] in t["text"]]
    value_tokens = [t for t in band if t not in label_tokens]

    # 一维 y 聚类 -> 当前/设定/控制 3 行
    ys = sorted(t["y2"] for t in value_tokens)
    clusters: list[list[float]] = []
    for y in ys:
        if clusters and y - clusters[-1][-1] <= row_tol:
            clusters[-1].append(y)
        else:
            clusters.append([y])
    if len(clusters) != 3:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ROW_CLUSTER_COUNT({len(clusters)})"], "detail": {}}
    row_names = ["current", "set", "control"]
    row_centers = {name: sum(c) / len(c) for name, c in zip(row_names, clusters)}
    # 锚点校验：set/control 聚类中心应与标签 y 接近
    if abs(row_centers["set"] - set_y) > row_tol or abs(row_centers["control"] - ctl_y) > row_tol:
        warnings.append("ROW_ANCHOR_MISMATCH")

    if cols is None:
        # 数字列头不足时的油温锚定回退（083 S01）：模板绝对列位在屏变体间
        # 平移/缩放漂移（实测 rec201/jiaming 油温列 x 漂移近一个列距），直接兜底
        # 会整行错列。改对数据区值 token 做一维 x 聚类：与实测油温列 x 对齐的
        # 簇为油温列，其左连续等距簇为料筒 1..N 列（不足 7 列按中位列距右补）；
        # 簇结构不完整才退模板绝对列位。
        tpl_spacing = layout["column_spacing_avg"]
        xs = sorted(t["x"] for t in value_tokens if NUM_RE.search(t["text"]))
        clusters_x: list[list[float]] = []
        for x in xs:
            if clusters_x and x - clusters_x[-1][-1] <= 0.3 * tpl_spacing:
                clusters_x[-1].append(x)
            else:
                clusters_x.append([x])
        centers = [sum(c) / len(c) for c in clusters_x]
        anchored = None
        if centers:
            d_oil, i_oil = min((abs(c - oil_x), i) for i, c in enumerate(centers))
            barrel = centers[:i_oil]
            gaps = [b - a for a, b in zip(barrel, barrel[1:])]
            if 5 <= len(barrel) <= 7 and gaps:
                med = sorted(gaps)[len(gaps) // 2]
                if (d_oil <= 0.6 * med
                        and all(g <= 1.5 * med for g in gaps)
                        and abs(med - tpl_spacing) <= 0.3 * tpl_spacing):
                    anchored = barrel + [barrel[-1] + med * j
                                         for j in range(1, 8 - len(barrel))]
        if anchored is None:
            cols = [layout["column_x_centers"][str(i)] for i in range(1, 8)]
        else:
            cols = anchored
            warnings.append("OIL_ANCHORED_COLUMNS")
        spacing = cols[1] - cols[0]
        col_tol = spacing / 2

    def row_of(t: dict) -> str | None:
        best, best_d = None, row_tol
        for name, c in row_centers.items():
            d = abs(t["y2"] - c)
            if d <= best_d:
                best, best_d = name, d
        return best

    def col_of(t: dict) -> int | None:
        """返回 1..7（料筒列）或 8（油温列）或 None。"""
        cands = [(abs(t["x"] - cx), i + 1) for i, cx in enumerate(cols)]
        cands.append((abs(t["x"] - oil_x), 8))
        d, i = min(cands)
        return i if d <= col_tol else None

    # 单元格填充：cells[row][col] = token
    def put_cell(row: str, col: int, t: dict) -> None:
        # 同格多 token 取先到的（更高 conf 通常先检出）；083 S13 例外——主 OCR
        # 对红字数码格截尾漏小数位（'290.2'->'290'、'2.9'->'2'），后到 token
        # 小数完整且以截尾读数为前缀（'290.2'/'2.9'）时替换为完整读数；
        # 其余冲突维持既有「先到优先」口径。
        cur = cells[row].get(col)
        if cur is None:
            cells[row][col] = t
            return
        m_cur, m_new = NUM_RE.search(cur["text"]), NUM_RE.search(t["text"])
        if (m_cur and m_new and not re.fullmatch(r"\d+\.\d+", m_cur.group())
                and "." in m_new.group()
                and m_new.group().startswith(m_cur.group())):
            cells[row][col] = t

    cells: dict[str, dict[int, dict]] = {r: {} for r in row_names}
    for t in value_tokens:
        r, c = row_of(t), col_of(t)
        if r and c:
            put_cell(r, c, t)
    # 行标签合并 token（如 '设定°C262.0'）：数值强制归该行第 1 个空格
    for t in label_tokens:
        if not NUM_RE.search(t["text"]):
            continue
        r = row_of(t) or ("set" if anchors["set"] in t["text"] else "control")
        for c in range(1, 9):
            if c not in cells[r]:
                cells[r][c] = t
                break

    def cell_number(row: str, col: int) -> tuple[float | None, dict | None]:
        t = cells[row].get(col)
        if t is None:
            return None, None
        m = NUM_RE.search(t["text"])
        return (float(m.group()) if m else None), t

    # 启用段数：当前值行从第 1 列起连续数值列
    heater_columns = 0
    gap_seen = False
    for c in range(1, 8):
        v, t = cell_number("current", c)
        if v is not None:
            if gap_seen:
                warnings.append(f"HEATER_GAP_BEFORE_COL{c}")
            heater_columns = c
        else:
            gap_seen = True  # 空缺或 */水 标记 -> 未启用
    if heater_columns == 0:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + ["NO_ENABLED_HEATER_COLUMN"], "detail": {}}

    # 组装字段
    def row_values(row: str, cols_needed: list[int]) -> tuple[list[float | None], list[str]]:
        vals, ws = [], []
        for c in cols_needed:
            v, t = cell_number(row, c)
            if v is None:
                ws.append(f"CELL_MISSING({row},col{c})")
            elif not re.fullmatch(r"\d+\.\d+", NUM_RE.search(t["text"]).group()):
                # 083 S13：ZizES 温度页数值恒带一位小数（含 0.0）；无小数点读数
                # 或尾点读数必是 OCR 截尾（'290.2'->'290'/'290.'、'2.9'->'2'），静默补 .0 会写
                # 错值——置缺并告警，触发逐格重读救援回补，宁缺不错。
                ws.append(f"DECIMAL_TRUNCATED({row},col{c}:{t['text']})")
                v = None
            elif t["conf"] < rules["min_cell_conf"]:
                ws.append(f"LOW_CONF({row},col{c},{t['conf']:.2f})")
            vals.append(v)
        return vals, ws

    barrel_cols = list(range(1, heater_columns + 1))
    cur, w1 = row_values("current", barrel_cols)
    setv, w2 = row_values("set", barrel_cols)
    ctl, w3 = row_values("control", barrel_cols)
    oil_cur, w4 = row_values("current", [8])
    oil_set, w5 = row_values("set", [8])
    warnings.extend(w1 + w2 + w3 + w4 + w5)

    fields = {
        "barrel_temperature_current_c": cur,
        "barrel_temperature_set_c": setv,
        "oil_temperature_current_c": oil_cur[0],
        "oil_temperature_set_c": oil_set[0],
        "control_percent": ctl,
    }

    # 范围校验
    t_lo, t_hi = rules["temperature_range_C"]
    p_lo, p_hi = rules["control_percent_range"]
    for name in ("barrel_temperature_current_c", "barrel_temperature_set_c"):
        for i, v in enumerate(fields[name]):
            if v is not None and not (t_lo <= v <= t_hi):
                warnings.append(f"VALUE_OUT_OF_RANGE({name}[{i}]={v})")
    for name in ("oil_temperature_current_c", "oil_temperature_set_c"):
        v = fields[name]
        if v is not None and not (t_lo <= v <= t_hi):
            warnings.append(f"VALUE_OUT_OF_RANGE({name}={v})")
    for i, v in enumerate(fields["control_percent"]):
        if v is not None and not (p_lo <= v <= p_hi):
            warnings.append(f"VALUE_OUT_OF_RANGE(control_percent[{i}]={v})")

    # current vs set 一致性（±tol，超出 -> review；真实报警态也会触发，属保守设计）
    tol_c = rules["current_set_consistency_tolerance_C"]
    for i, (cv, sv) in enumerate(zip(fields["barrel_temperature_current_c"],
                                     fields["barrel_temperature_set_c"])):
        if cv is not None and sv is not None and abs(cv - sv) > tol_c:
            warnings.append(f"CURRENT_SET_INCONSISTENT(col{i + 1}: {cv} vs {sv})")

    detail = {
        "columns_measured": [round(c, 4) for c in cols] + [round(oil_x, 4)],
        "row_centers": {r: round(c, 4) for r, c in row_centers.items()},
        "deskew_slope": round(k, 4),
        "cells": {r: {str(c): {"text": t["text"], "conf": round(t["conf"], 3)}
                      for c, t in cells[r].items()} for r in row_names},
    }
    return {"fields": fields, "heater_columns": heater_columns,
            "warnings": warnings, "detail": detail}


def _box(l: dict) -> tuple[float, float, float, float]:
    b = l["bbox"]
    return b["x_min"], b["y_min"], b["x_max"], b["y_max"]


def _iou(a: dict, b: dict) -> float:
    ax1, ay1, ax2, ay2 = _box(a)
    bx1, by1, bx2, by2 = _box(b)
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    return inter / (area_a + area_b - inter)


def _center_inside(l: dict, box: dict) -> bool:
    cx = (l["bbox"]["x_min"] + l["bbox"]["x_max"]) / 2
    cy = (l["bbox"]["y_min"] + l["bbox"]["y_max"]) / 2
    bx1, by1, bx2, by2 = _box(box)
    return bx1 <= cx <= bx2 and by1 <= cy <= by2


def merge_variant_lines(base_lines: list[dict], variant_lines: list[dict]) -> tuple[list[dict], dict]:
    """把 CLAHE 变体 OCR 行合并进基础 OCR 行（TACT 低对比白底框召回补充）。

    规则（保守，保错误自动入库率 = 0）：
    - 变体行与任一基础行同位（IoU >= 0.2 或互相包含中心点）：仅当基础行 conf < 0.7
      且变体行 conf >= 0.9 且文本不同，才用变体行替换（低置信误读纠正）；
    - 无同位基础行：作为补充行追加（填补基础 OCR 漏检），并标记
      _src="ocr_variant"（033_FIX 修复3：下游同格异值冲突时主 OCR 值优先）。
    返回 (合并后的 lines, {"added": n, "replaced": n})。
    """
    merged = [dict(l) for l in base_lines]
    stats = {"added": 0, "replaced": 0}
    for v in variant_lines:
        hit = None
        for i, b in enumerate(merged):
            if _iou(b, v) >= 0.2 or _center_inside(v, b) or _center_inside(b, v):
                hit = i
                break
        if hit is None:
            added = dict(v)
            added["_src"] = "ocr_variant"
            merged.append(added)
            stats["added"] += 1
        else:
            b = merged[hit]
            if b["text"] != v["text"] and b["conf"] < 0.7 and v["conf"] >= 0.9:
                merged[hit] = dict(v)
                stats["replaced"] += 1
    return merged, stats


def extract_temperature_tact(toks: list[dict], template: dict) -> dict:
    """TACT 温度页提取主逻辑（5 段料筒 + 落下口独立列，设定/现在/控制/保温 4 行）。

    与 ZizES 的差异：列头是区段中文名（喷嘴/筒头/前部/中部/后部/落下口）而非数字+油温；
    行标签（设定温度/现在温度/控制输出/保温温度）直接给出 4 行锚点，无需 y 聚类；
    落下口只有设定/现在/控制三行。返回 {fields, heater_columns, warnings, detail}。
    """
    warnings: list[str] = []
    anchors = template["row_anchors"]
    layout = template["layout"]
    rules = template["validation_rules"]
    zones = template["zone_labels"]
    drop = template["drop_port_label"]
    row_names = ["set", "current", "control", "holding"]

    # TACT5 变体（083 S01）：末段列头带序号（后部1/后部2），模板固定标签“后部”
    # 子串命中“后部1”会把后部2 整列挤进落下口外推列。实测到编号列头时按序展开。
    numbered = sorted({m.group(0) for t in toks
                       if (m := re.fullmatch(r"后部\s*\d", norm_cjk(t["text"]).strip()))},
                      key=lambda s: int(re.search(r"\d", s).group()))
    if numbered:
        zones = [z for z in zones if z != "后部"] + numbered
        warnings.append(f"ZONE_VARIANT(编号末段:{'/'.join(numbered)})")

    # 列位：区段中文列头实测；中间段整列不存在按实际段数提取（变体自适应，033）；
    # 边缘段（喷嘴/落下口）缺失按实测列距中位数外推（变体布局下模板坐标不可用）
    col_x: dict[str, float] = {}
    header_toks = []
    missing_labels = []
    for label in zones + [drop]:
        hits = [t for t in toks if label in norm_cjk(t["text"])]
        if hits:
            col_x[label] = hits[0]["x"]
            header_toks.append(hits[0])
        else:
            missing_labels.append(label)
    mid_missing = [m for m in missing_labels if m in zones[1:-1]]
    # 083 S07：左缘连续缺失前缀（反光/裁切连丢 喷嘴+筒头 两列头）逐列向左
    # 等距外推——每列须有自己的数值列证据（列头行下方 ≥2 个数值 token，
    # 防虚构列），并吸附证据 token 的中位 x（多列等距外推的累积偏差可达
    # 半个列距）。单列前缀缺失维持原有单格外推口径不变。
    prefix_missing = []
    for m in zones:
        if m in missing_labels:
            prefix_missing.append(m)
        else:
            break
    if len(prefix_missing) >= 2 and len(col_x) >= 3:
        xs0 = sorted(col_x.values())
        gaps0 = sorted(b - a for a, b in zip(xs0, xs0[1:]))
        gap0 = gaps0[len(gaps0) // 2] if gaps0 else 0.1
        header_y0 = min(t["y"] for t in header_toks)
        snapped: dict[str, float] = {}
        for i, m in enumerate(reversed(prefix_missing)):
            x_c = min(xs0) - gap0 * (i + 1)
            ev = [t for t in toks if NUM_RE.search(t["text"])
                  and abs(t["x"] - x_c) < 0.45 * gap0 and t["y"] > header_y0 + 0.01]
            if len(ev) < 2:
                snapped = {}
                break
            snapped[m] = sorted(t["x"] for t in ev)[len(ev) // 2]
        if snapped:
            for m, x in snapped.items():
                col_x[m] = x
                warnings.append(f"ZONE_HEADER_EXTRAPOLATED({m})")
            missing_labels = [m for m in missing_labels if m not in snapped]
            mid_missing = [m for m in mid_missing if m not in snapped]
    if mid_missing and len(header_toks) >= 4:
        # 083 S09：中间段列头淡出（老化屏整字丢失，如 Z077 '筒头' 头无 OCR 命中
        # 但该列设定/现在/控制/保温数值完整）先证据重建再判变体，三重证据缺一不可：
        # 1) 物理列距校验——其余相邻实测列的列头列距中位为基准 pitch，目标缺口
        #    列头距离 round(gap/pitch) 须达到区间段索引距（Z011 喷嘴/前部为相邻
        #    真列，gap≈1 pitch，筒头物理不存在，维持塌缩；Z077 gap≈2 pitch 才重建）；
        # 2) 数据列插值——列头标签相对数据按钮有系统性左偏，用各列带小数点数据
        #    token 中位 x（数据列中心）插值期望列位（TACT 四行数据恒一位小数；
        #    温度计整数刻度分布于列窗左缘，混入会拉偏中位 x 致相邻列串列）；
        # 3) 孤儿数值列——期望列位 ±0.45 列距窗内列头行下方 ≥3 个带小数点数据
        #    token，且均不落在任一实测列的数据列容差内（防相邻列数据扩散成幻影）。
        # 任一不满足则按原口径塌缩为变体，行为与修复前一致。
        hy0 = min(t["y"] for t in header_toks)

        def _data_cx(c: str) -> float:
            xs_d = sorted(t["x"] for t in toks
                          if NUM_RE.search(t["text"]) and "." in t["text"]
                          and abs(t["x"] - col_x[c]) < 0.04 and t["y"] > hy0 + 0.01)
            return xs_d[len(xs_d) // 2] if xs_d else col_x[c]

        found = [(idx, z) for idx, z in enumerate(zones) if z in col_x]
        pitches = [(col_x[z2] - col_x[z1]) / (i2 - i1)
                   for (i1, z1), (i2, z2) in zip(found, found[1:])
                   if col_x[z2] > col_x[z1]]
        pitch = sorted(pitches)[len(pitches) // 2] if pitches else 0.0

        for m in list(mid_missing):
            i = zones.index(m)
            left = next((j for j in range(i - 1, -1, -1) if zones[j] in col_x), None)
            right = next((j for j in range(i + 1, len(zones)) if zones[j] in col_x), None)
            if left is None or right is None or pitch <= 0:
                continue
            # 物理列距校验：缺口实测距离按基准 pitch 折算的物理段数须覆盖
            # 区间段索引距，否则该段物理不存在（真变体），直接留给塌缩
            if round((col_x[zones[right]] - col_x[zones[left]]) / pitch) < right - left:
                continue
            left_cx, right_cx = _data_cx(zones[left]), _data_cx(zones[right])
            col_gap = (right_cx - left_cx) / (right - left)
            if col_gap <= 0:
                continue
            x_c = left_cx + col_gap * (i - left)
            ev = [t for t in toks if NUM_RE.search(t["text"]) and "." in t["text"]
                  and abs(t["x"] - x_c) < 0.45 * col_gap and t["y"] > hy0 + 0.01]
            ev = [t for t in ev
                  if all(abs(t["x"] - _data_cx(c)) >= 0.45 * col_gap for c in col_x)]
            if len(ev) >= 3:
                col_x[m] = sorted(t["x"] for t in ev)[len(ev) // 2]
                warnings.append(f"ZONE_HEADER_REBUILT({m})")
                mid_missing.remove(m)
                missing_labels.remove(m)
        for m in mid_missing:
            zones = [z for z in zones if z != m]
            warnings.append(f"ZONE_VARIANT({len(zones)}段,无{m})")
        missing_labels = [m for m in missing_labels if m not in mid_missing]
    if missing_labels and len(col_x) >= 3:
        xs = sorted(col_x.values())
        gaps = sorted(b - a for a, b in zip(xs, xs[1:]))
        gap = gaps[len(gaps) // 2] if gaps else 0.1
        for m in missing_labels:
            if m == zones[0]:
                x_e = xs[0] - gap
                # 083 S08：单列左缘外推吸附证据中位 x（同 S07 多列前缀口径）——
                # 纯几何外推 xs[0]-gap 对格宽/尾缀字符导致的 token 中心散布
                # 敏感，会在半列距容差边缘把同列宽格（'250.0:'）挤出列；
                # 须列头行下方 ≥2 个数值 token 证据才吸附，否则维持几何外推。
                hy0 = min(t["y"] for t in header_toks)
                ev = [t for t in toks if NUM_RE.search(t["text"])
                      and abs(t["x"] - x_e) < 0.45 * gap and t["y"] > hy0 + 0.01]
                if len(ev) >= 2:
                    x_e = sorted(t["x"] for t in ev)[len(ev) // 2]
                col_x[m] = x_e
                xs.insert(0, col_x[m])
                warnings.append(f"ZONE_HEADER_EXTRAPOLATED({m})")
            elif m == drop:
                col_x[m] = xs[-1] + gap
                xs.append(col_x[m])
                warnings.append(f"ZONE_HEADER_EXTRAPOLATED({m})")
            else:
                col_x[m] = layout["column_x_centers"][m]
                warnings.append(f"ZONE_HEADER_FALLBACK({m})")
    else:
        for m in missing_labels:
            col_x[m] = layout["column_x_centers"][m]
            warnings.append(f"ZONE_HEADER_FALLBACK({m})")
    if len(header_toks) < 4:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"COLUMN_HEADERS_NOT_FOUND({len(header_toks)})"], "detail": {}}

    # 去斜：区段列头行拟合 y = k*(x-0.5) + c（同 ZizES 的 deskew_slope 思路）
    k = 0.0
    if len(header_toks) >= 3:
        mx = sum(t["x"] for t in header_toks) / len(header_toks)
        my = sum(t["y"] for t in header_toks) / len(header_toks)
        denom = sum((t["x"] - mx) ** 2 for t in header_toks)
        if denom > 1e-6:
            k = sum((t["x"] - mx) * (t["y"] - my) for t in header_toks) / denom
    for t in toks:
        t["y2"] = t["y"] - k * (t["x"] - 0.5)

    # 行位：行标签实测，缺失回退模板坐标
    row_y: dict[str, float] = {}
    label_toks = []
    fallback_rows = []
    for name in row_names:
        hits = [t for t in toks if anchors[name] in norm_cjk(t["text"])]
        if hits:
            row_y[name] = hits[0]["y2"]
            label_toks.append(hits[0])
        else:
            row_y[name] = layout["row_y_centers"][name]
            fallback_rows.append(name)
            warnings.append(f"ROW_LABEL_FALLBACK({name})")
    if 0 < len(label_toks) < 3:
        # 083 S08：行标签部分缺失（老化发黄/反光仅余 1-2 个锚，'保温温度' 被误读为
        # '温温货' 等不再命中锚文本）不再直接硬拒——用段列数值簇重建行位并以实测
        # 锚点交叉校验：逐列 y2 聚类后仅保留「前 4 簇为 温度/温度/百分比/温度
        # 签名」的干净段列（落下口仅 3 行、其温度计刻度易凑出幻影第 4 簇，不参与；
        # 缺格列因簇错位过不了签名，自我排除），≥3 个干净列取逐行中位得重建行位；
        # 每个实测标签须落在对应重建行位 ±max(row_tol, 0.5g) 内（g 为干净列相邻
        # 簇距中位），否则维持原硬拒。校验通过也只回填补缺失行，不覆盖实测行位。
        hy1 = sum(t["y2"] for t in header_toks) / len(header_toks)
        p_lo1, p_hi1 = rules["control_percent_range"]
        t_lo1, t_hi1 = rules["temperature_range_C"]

        def _row_sig_ok(rows_c: list[list[dict]]) -> bool:
            for ri, kind in ((0, "t"), (1, "t"), (2, "p"), (3, "t")):
                for t in rows_c[ri]:
                    raw = NUM_RE.search(t["text"]).group()
                    v = float(raw)
                    if kind == "p":
                        if not (p_lo1 <= v <= p_hi1 or
                                ("." not in raw and p_lo1 <= v / 10 <= p_hi1)):
                            return False
                    elif not (t_lo1 <= v <= t_hi1 or
                              ("." not in raw and len(raw) == 4
                               and t_lo1 <= v / 10 <= t_hi1)):
                        # 4 位无点还原形态（'3451'->345.1）只作行签名证据；
                        # 单元格取值仍走既有 _cell_eligible 形态罚分
                        return False
            return True

        clean: list[list[float]] = []
        for c in zones:
            ct = sorted([t for t in toks if NUM_RE.search(t["text"])
                         and abs(t["x"] - col_x[c]) <= 0.05 and t["y2"] > hy1 + 0.01],
                        key=lambda t: t["y2"])
            rows_c: list[list[dict]] = []
            for t in ct:
                if rows_c and t["y2"] - rows_c[-1][-1]["y2"] <= 0.02:
                    rows_c[-1].append(t)
                else:
                    rows_c.append([t])
            if len(rows_c) >= 4 and _row_sig_ok(rows_c):
                clean.append([rows_c[i][0]["y2"] for i in range(4)])
        rebuilt = None
        if len(clean) >= 3:
            med = [sorted(r[i] for r in clean)[len(clean) // 2] for i in range(4)]
            gaps = sorted(b - a for r in clean for a, b in zip(r, r[1:]))
            tol_a = max(layout["row_y_tolerance"], 0.5 * gaps[len(gaps) // 2])
            if all(abs(med[row_names.index(n)] - row_y[n]) <= tol_a
                   for n in row_names if n not in fallback_rows):
                rebuilt = med
        if rebuilt is None:
            return {"fields": None, "heater_columns": 0,
                    "warnings": warnings + [f"ROW_LABELS_NOT_FOUND({len(label_toks)})"],
                    "detail": {}}
        for ri, name in enumerate(row_names):
            if name in fallback_rows:
                row_y[name] = rebuilt[ri]
        warnings.append(
            f"ROW_LABELS_ANCHORED_REBUILD(found={len(label_toks)},cols={len(clean)})")
    if not label_toks:
        # 083 S07：行标签整体缺失（五段变体标签列被反光/裁切整列丢失）不再硬拒——
        # 先按模板行位回退（既有 ROW_LABEL_FALLBACK 逐行口径），再用列跨距内数值
        # token 的 y2 聚类重建行位：列头行下方前 4 个行簇即 set/current/control/
        # holding（行序固定），第 3 簇须全为百分比值域（控制行签名）——本变体
        # 温度计刻度行恰好落在模板保温行位，仅靠模板行位会整行错位。
        warnings.append("ROW_LABELS_ALL_FALLBACK")
        hy = sum(t["y2"] for t in header_toks) / len(header_toks)
        # 逐列聚类再取跨列中位：同列内 token 无去斜残差，行簇干净
        # （整表混合聚类会被行内 y2 扩散与相邻行间距倒置误并）
        p_lo2, p_hi2 = rules["control_percent_range"]
        per_col: list[list[float]] = []
        for c in zones + [drop]:
            ct = sorted([t for t in toks if NUM_RE.search(t["text"])
                         and abs(t["x"] - col_x[c]) <= 0.05 and t["y2"] > hy + 0.01],
                        key=lambda t: t["y2"])
            rows_c: list[list[dict]] = []
            for t in ct:
                if rows_c and t["y2"] - rows_c[-1][-1]["y2"] <= 0.02:
                    rows_c[-1].append(t)
                else:
                    rows_c.append([t])
            if len(rows_c) >= 4:
                per_col.append(rows_c)
        if len(per_col) >= 4:
            ctl_texts = [t["text"] for rows_c in per_col for t in rows_c[2]]
            ctl_ok = True
            for text in ctl_texts:
                raw = NUM_RE.search(text).group()
                v = float(raw)
                if not (p_lo2 <= v <= p_hi2 or
                        ("." not in raw and p_lo2 <= v / 10 <= p_hi2)):
                    ctl_ok = False
                    break
            if ctl_ok:
                for ri, name in enumerate(row_names):
                    ys_r = sorted(rows_c[ri][0]["y2"] for rows_c in per_col)
                    row_y[name] = ys_r[len(ys_r) // 2]
                warnings.append("ROWS_FROM_VALUE_CLUSTERS(4)")
    if not (row_y["set"] < row_y["current"] < row_y["control"] < row_y["holding"]):
        warnings.append("ROW_ORDER_ABNORMAL")

    spacing = (col_x[drop] - col_x[zones[0]]) / len(zones)
    col_tol = min(layout["col_x_tolerance"], spacing / 2)
    row_tol = layout["row_y_tolerance"]
    g = min(row_y[b] - row_y[a] for a, b in zip(row_names, row_names[1:]))

    # 数据区 token：去斜后落在 (列头行, 保温行+tol] 内，排除列头与行标签结构 token
    # （HSV 设定行旁车 set_cell 不参与通用 band，只在设定行缺格时定点补充）
    # 083 S05：band 下界放宽到 holding + 1.75g（同 B&R 口径）——透视畸变使右侧
    # 各行 y2 随 x 下移可达约一个行距，右缘保温真值会被旧下界切掉，先收进来
    # 再按列对齐（温度计刻度等杂值由未分配罚吸收，不进单元格）。
    header_y = sum(t["y2"] for t in header_toks) / len(header_toks)
    struct_ids = {id(t) for t in header_toks + label_toks}
    band = [t for t in toks if header_y + 0.01 < t["y2"] <= row_y["holding"] + 1.75 * g
            and id(t) not in struct_ids and t.get("src") != "set_cell"]

    # 083 S05 逐列垂直对齐（同 B&R align_column 思路）：透视实拍右侧各行 y2
    # 随 x 整体下移，列头全局斜率 + 固定行位在右缘错行（Z025 后部控制值掉进
    # 保温行）。对每列在 o ∈ [-0.6g, 1.6g] 网格搜索垂直平移量，
    # 得分 = 归属距离和 + 未分配罚 + |o| 先验；正面图 o≈0 胜出，行为不变。
    # 行值域/形态硬约束（同 B&R）：控制行限百分比值域（含既有 /10 还原口径）；
    # 温度行限温度值域，裸整数（OCR 丢小数点 '280' 与温度计刻度 360/315- 同形）
    # 带 0.5*row_tol 形态罚分——只补空格，赢不了带小数点的真格；% 尾缀
    # （保温行低对比误读 '200%'）与 4 位无点还原形态（'2700'->270.0）不罚。
    t_lo, t_hi = rules["temperature_range_C"]
    p_lo, p_hi = rules["control_percent_range"]

    def _cell_eligible(t: dict, row: str) -> tuple[bool, float]:
        m = NUM_RE.search(t["text"])
        if not m:
            return False, 0.0
        raw = m.group()
        v = float(raw)
        if row == "control":
            ok = p_lo <= v <= p_hi or ("." not in raw and p_lo <= v / 10 <= p_hi)
            return ok, 0.0
        # 4 位无点 /10 还原形态（'2700'->270.0、'2801'->280.1）不罚
        if "." not in raw and len(raw) == 4 and t_lo <= v / 10 <= t_hi:
            return True, 0.0
        if not (t_lo <= v <= t_hi):
            return False, 0.0
        if "." in t["text"] or "%" in t["text"]:
            return True, 0.0
        return True, 0.5 * row_tol

    cells = {r: {} for r in row_names}
    for c in zones + [drop]:
        col_toks = [t for t in band if abs(t["x"] - col_x[c]) <= col_tol]
        if not col_toks:
            continue
        best = None
        o = -0.6 * g
        while o <= 1.6 * g + 1e-9:
            assigned: dict[str, tuple[float, dict]] = {}
            un = 0
            for t in col_toks:
                cands = [(n, _cell_eligible(t, n)[1]) for n in row_names
                         if _cell_eligible(t, n)[0]]
                if not cands:
                    un += 1
                    continue
                d, r = min((abs(t["y2"] - (row_y[n] + o)) + pen, n) for n, pen in cands)
                if d <= row_tol and r not in assigned:
                    assigned[r] = (d, t)
                else:
                    un += 1
            score = sum(d for d, _ in assigned.values()) + 0.5 * g * un + 0.05 * abs(o)
            if best is None or score < best[0] - 1e-9:
                best = (score, {r: t for r, (d, t) in assigned.items()})
            o += 0.05 * g
        for r, t in best[1].items():
            cells[r][c] = t
    # 行标签与首格合并的 token（标签文本内含数字）：数值归该行第一个空格
    for name, t in zip(row_names, label_toks):
        if not NUM_RE.search(t["text"]):
            continue
        for c in zones + [drop]:
            if c not in cells[name]:
                cells[name][c] = t
                break

    # 设定行 HSV 旁车补充（033）：基础/CLAHE 对红渐变框整行漏检时，用 set_cell
    # token 定点补设定行空格；仅数字形态 token、x 吸附列位、4 位无点按 /10 还原小数、
    # 值域护栏（料筒 [100,450]、落下口 [10,120]）防图形杂值误吸附
    sc = [t for t in toks if t.get("src") == "set_cell"]
    if sc and any(c not in cells["set"] for c in zones + [drop]):
        import re as _re
        numish = [t for t in sc
                  if _re.fullmatch(r"[\d.]+[%℃°Cc]*", t["text"].strip())
                  and sum(ch.isdigit() for ch in t["text"]) >= 2 and t["conf"] >= 0.6]
        if numish:
            if "set" in fallback_rows:
                row_y["set"] = sorted(t["y2"] for t in numish)[len(numish) // 2]
            for c in zones + [drop]:
                if c in cells["set"]:
                    continue
                near = [t for t in numish if abs(t["x"] - col_x[c]) <= col_tol]
                if not near:
                    continue
                t = min(near, key=lambda t: abs(t["x"] - col_x[c]))
                raw = NUM_RE.search(t["text"]).group()
                if "." not in raw and len(raw) == 4:
                    raw = raw[:3] + "." + raw[3]
                # 值域护栏：料筒设定 [100,450]，落下口设定 [10,120]，防图形杂值误吸附
                v = float(raw)
                lo, hi = (10.0, 120.0) if c == drop else (100.0, 450.0)
                if not (lo <= v <= hi):
                    continue
                cells["set"][c] = {**t, "text": raw, "_from": "set_cell"}
                warnings.append(f"SET_CELL_RESCUE({c})")

    def cell_number(row: str, col: str, lo: float, hi: float,
                    restored: list[str]) -> tuple[float | None, dict | None]:
        t = cells[row].get(col)
        if t is None:
            return None, None
        m = NUM_RE.search(t["text"])
        if not m:
            return None, t
        raw = m.group()
        if "." not in raw and len(raw) == 4:
            raw = raw[:3] + "." + raw[3]  # OCR 丢小数点（2718->271.8）
        v = float(raw)
        if "." not in raw and not (lo <= v <= hi) and lo <= v / 10 <= hi:
            # OCR 丢小数点且原值越界（550->55.0、415->41.5）：仅在 /10 后落回
            # 值域才还原，并留 DECIMAL_RESTORED 告警强制复核，不静默改值。
            restored.append(f"DECIMAL_RESTORED({row},{col}:{v}->{v / 10})")
            v = v / 10
        return v, t

    def row_values(row: str, cols_needed: list[str], lo: float, hi: float,
                   restored: list[str]) -> tuple[list[float | None], list[str]]:
        vals, ws = [], []
        for c in cols_needed:
            v, t = cell_number(row, c, lo, hi, restored)
            if v is None:
                ws.append(f"CELL_MISSING({row},{c})")
            elif t is not None and t["conf"] < rules["min_cell_conf"]:
                ws.append(f"LOW_CONF({row},{c},{t['conf']:.2f})")
            vals.append(v)
        return vals, ws

    t_rng = rules["temperature_range_C"]
    p_rng = rules["control_percent_range"]
    restored: list[str] = []
    setv, w1 = row_values("set", zones, *t_rng, restored)
    cur, w2 = row_values("current", zones, *t_rng, restored)
    ctl, w3 = row_values("control", zones, *p_rng, restored)
    hold, w4 = row_values("holding", zones, *t_rng, restored)
    drop_set, w5 = row_values("set", [drop], *t_rng, restored)
    drop_cur, w6 = row_values("current", [drop], *t_rng, restored)
    drop_ctl, w7 = row_values("control", [drop], *p_rng, restored)
    warnings.extend(w1 + w2 + w3 + w4 + w5 + w6 + w7)
    warnings.extend(restored)

    fields = {
        "barrel_temperature_set_c": setv,
        "barrel_temperature_current_c": cur,
        "control_percent": ctl,
        "holding_temperature_c": hold,
        "drop_port_temperature_set_c": drop_set[0],
        "drop_port_temperature_current_c": drop_cur[0],
        "drop_port_control_percent": drop_ctl[0],
    }

    # 范围校验
    t_lo, t_hi = rules["temperature_range_C"]
    p_lo, p_hi = rules["control_percent_range"]
    for name in ("barrel_temperature_set_c", "barrel_temperature_current_c",
                 "holding_temperature_c"):
        for i, v in enumerate(fields[name]):
            if v is not None and not (t_lo <= v <= t_hi):
                warnings.append(f"VALUE_OUT_OF_RANGE({name}[{i}]={v})")
    for name in ("drop_port_temperature_set_c", "drop_port_temperature_current_c"):
        v = fields[name]
        if v is not None and not (t_lo <= v <= t_hi):
            warnings.append(f"VALUE_OUT_OF_RANGE({name}={v})")
    for i, v in enumerate(fields["control_percent"]):
        if v is not None and not (p_lo <= v <= p_hi):
            warnings.append(f"VALUE_OUT_OF_RANGE(control_percent[{i}]={v})")
    v = fields["drop_port_control_percent"]
    if v is not None and not (p_lo <= v <= p_hi):
        warnings.append(f"VALUE_OUT_OF_RANGE(drop_port_control_percent={v})")

    # current vs set 一致性（±tol，超出 -> review；仅料筒段，落下口待机温差大不校验）
    tol_c = rules["current_set_consistency_tolerance_C"]
    for i, (cv, sv) in enumerate(zip(fields["barrel_temperature_current_c"],
                                     fields["barrel_temperature_set_c"])):
        if cv is not None and sv is not None and abs(cv - sv) > tol_c:
            warnings.append(f"CURRENT_SET_INCONSISTENT({zones[i]}: {cv} vs {sv})")

    detail = {
        "columns_measured": {lb: round(x, 4) for lb, x in col_x.items()},
        "row_centers": {r: round(row_y[r], 4) for r in row_names},
        "deskew_slope": round(k, 4),
        "cells": {r: {c: {"text": t["text"], "conf": round(t["conf"], 3)}
                      for c, t in cells[r].items()} for r in row_names},
    }
    return {"fields": fields, "heater_columns": len(zones),
            "warnings": warnings, "detail": detail}


# ---------------------------------------------------------------- 家族提取器（026 S7 拆出）
from extract_families.keba import extract_temperature_keba  # noqa: E402
from extract_families.b_and_r import extract_temperature_b_and_r  # noqa: E402
from extract_families.fanuc import extract_temperature_fanuc  # noqa: E402
from extract_families.demag import extract_temperature_demag  # noqa: E402
from extract_families.tact_injection import extract_injection_tact  # noqa: E402
from extract_families.demag_injection import extract_injection_demag  # noqa: E402
from extract_families.fanuc_injection import extract_injection_fanuc  # noqa: E402
from extract_families.zizes_injection import extract_injection_zizes  # noqa: E402
from extract_families.keba_injection import extract_injection_keba  # noqa: E402
from extract_families.b_and_r_injection import extract_injection_b_and_r  # noqa: E402
from extract_families.kaiming_injection import extract_injection_kaiming  # noqa: E402
from extract_families.kaiming_temperature import extract_temperature_kaiming  # noqa: E402
from extract_families.est_temperature import extract_temperature_est  # noqa: E402
from extract_families.est_injection import extract_injection_est  # noqa: E402
from extract_families.trd6_injection import extract_injection_trd6  # noqa: E402
from extract_families.trd6_temperature import extract_temperature_trd6  # noqa: E402
from extract_families.arburg_injection import extract_injection_arburg  # noqa: E402
from extract_families.fanuc_molding_monitor import extract_molding_monitor_fanuc  # noqa: E402
from extract_families.fanuc_waveform import extract_waveform_fanuc  # noqa: E402
from extract_families.tact_hot_runner import extract_hot_runner_tact  # noqa: E402
from extract_families.fanuc_mold_temp import extract_mold_temp_fanuc  # noqa: E402
from extract_families.mold_temp_devices import (  # noqa: E402
    extract_mold_temp_industrial_chiller, extract_mold_temp_omron_e5cc,
    extract_mold_temp_thermoregulator, is_lcd_pv_set)


# ---------------------------------------------------------------- 主流程
# 083 S03 温度表逐格重读救援（service/retest 共用判定）：B&R/DEMAG 温度页
# 提取出现缺格/列结构失败时，生成逐格 rec 旁车后重提取一次，仅缺格变少才采用。
# 083 S10 增补 VALUE_OUT_OF_RANGE：DEMAG 偏差行竖向粘连合并 token（'2020'
# 占两格）超量程被值域门禁置空时，逐格重读可读到正确单格值（row_at 值域内
# 旁车优先口径 083 S03 已就位），采用仍以告警变少为硬条件。
# 083 S13（095 S02 B013）增补 DECIMAL_TRUNCATED 与 ZizES：ZizES 红字数码格
# 主 OCR 截尾漏小数位（'290.2'->'290'、'2.9'->'2'），提取器把截尾格置缺并告警，
# 逐格重读（实测几何网格）可回补正确值；采用仍以告警变少为硬条件。
CELL_RESCUE_TRIGGERS = ("CELL_MISSING", "COLUMN_MISSING", "COLUMN_CLUSTER_COUNT",
                        "TEMPLATE_COLUMNS_FALLBACK", "COLUMNS_NOT_FOUND",
                        "ROW_LABELS_NOT_FOUND", "ROW_ANCHORS_NOT_FOUND",
                        "VALUE_OUT_OF_RANGE", "DECIMAL_TRUNCATED")
CELL_RESCUE_FAMILIES = ("B_AND_R", "DEMAG", "ZIZES")


def cell_rescue_needed(ext: dict) -> bool:
    """温度页提取结果含缺格/列结构告警（或字段全缺）时触发逐格重读救援。"""
    if ext.get("page_type") != "temperature":
        return False
    if str(ext.get("controller_family") or "").upper() not in CELL_RESCUE_FAMILIES:
        return False
    warnings = ext.get("warnings") or []
    return any(any(w.startswith(t) for t in CELL_RESCUE_TRIGGERS) for w in warnings)


def cell_rescue_better(old: dict, new: dict) -> bool:
    """救援重提取仅在字段可出且缺格/越界告警更少时采用（不放大风险）。"""
    if new.get("fields") is None:
        return False

    def score(e: dict) -> int:
        return sum(1 for w in (e.get("warnings") or [])
                   if w.startswith(("CELL_MISSING", "VALUE_OUT_OF_RANGE",
                                    "DECIMAL_TRUNCATED"))) \
            + (1000 if e.get("fields") is None else 0)

    return score(new) < score(old)


def extract_one(stem: str, rectified_dir: Path, record_report: dict | None,
                machine_labels: dict | None, templates_dir: Path) -> dict:
    ocr_path = rectified_dir / f"{stem}.ocr.json"
    meta_path = rectified_dir / f"{stem}.rectify.json"
    result = {"image": stem, "status": "reject", "warnings": []}
    if not meta_path.is_file() or not ocr_path.is_file():
        result["warnings"].append("RECTIFIED_OCR_MISSING")
        return result

    meta = json.loads(meta_path.read_text())
    ocr_data = json.loads(ocr_path.read_text())
    if not meta.get("ok"):
        result["warnings"].extend(meta.get("warnings", []) or ["RECTIFY_FAILED"])
        return result

    lines = ocr_data.get("lines", [])
    family, family_src = route_family(stem, lines, record_report, machine_labels)
    clahe_path = rectified_dir / f"{stem}.ocr_clahe.json"
    clahe_lines = None
    if clahe_path.is_file():
        clahe_lines = json.loads(clahe_path.read_text()).get("lines", [])
    # 042 S04：模温机数码管旁车（含原图全量 OCR 行）。整机照片 rectify 可能扭曲
    # 丢内容（mt_rear_B07_fd01ca17 矫正图主 OCR 0 行），锚文本仅存在于原图
    # 全量行——判族兜底与页面锚点路由必须能看到它们（坐标系与主 OCR 不同，
    # 仅取文本参与锚点匹配，不进 find_page 位置启发）。
    mt_path = rectified_dir / f"{stem}.ocr_mt.json"
    mt_lines = json.loads(mt_path.read_text()).get("lines", []) if mt_path.is_file() else []
    lcd_pv_set = family == "unknown" and is_lcd_pv_set(mt_lines)
    if lcd_pv_set:
        family, family_src = "INDUSTRIAL_CHILLER", "mold_temp_lcd_signature"
    if family == "unknown":
        # 伯乐 KEBA/B_AND_R 等无 record/机台先验且单图关键词分类失败的图：
        # 合并 CLAHE 变体后按各模板的 family_detect_groups 判族（不改既有路由优先级）
        det_lines = lines
        if clahe_lines is not None:
            det_lines, _ = merge_variant_lines(lines, clahe_lines)
        fam = detect_family_from_templates(det_lines + mt_lines, templates_dir)
        if fam:
            family, family_src = fam, "template_keywords"
    page, page_src = route_page(stem, lines, family, templates_dir,
                                extra_anchor_lines=mt_lines)
    if lcd_pv_set:
        page, page_src = "mold_temp", "mold_temp_lcd_signature"
    result["controller_family"] = family
    result["page_type"] = page

    template = load_template(family, page, templates_dir) if family != "unknown" else None
    if template is None and family == "DEMAG" and page in ("injection_metering", "monitor_curve"):
        # DEMAG 多级注射曲线页被分类器记为 monitor_curve，统一走射保模板（035 第二波）
        template = load_template(family, "injection_metering", templates_dir)
        if template is not None:
            page = "injection_metering"
            result["page_type"] = page
    if template is None and family == "TRD6" and page in ("injection_metering", "settings"):
        # TRD6 注射设定页被分类器记为 settings，统一走射保模板（049 A6）
        template = load_template(family, "injection_metering", templates_dir)
        if template is not None:
            page = "injection_metering"
            result["page_type"] = page
    if template is None and family == "ARBURG" and page in ("injection_metering", "monitor_curve", "unknown"):
        # ARBURG 注射页含曲线图被记为 monitor_curve/unknown，统一走射保模板（049 A7）
        template = load_template(family, "injection_metering", templates_dir)
        if template is not None:
            page = "injection_metering"
            result["page_type"] = page
    if template is None and family_src in ("machine_labels", "record_report"):
        # 083 S07：机台先验/record 聚合与图像内容冲突（先验家族无此页模板，如
        # Z019 先验 TACT 而实拍为沙迪克 TRD6 温度设定页）时的最后兜底——
        # 模板指纹重判族并重路由页面；指纹不全命中或目标页仍无模板则维持
        # NO_TEMPLATE。仅作用于原本必拒的路径，不改既有成功路由。
        det_lines = lines
        if clahe_lines is not None:
            det_lines, _ = merge_variant_lines(lines, clahe_lines)
        alt = detect_family_from_templates(det_lines + mt_lines, templates_dir)
        if alt and alt != family:
            alt_page, alt_page_src = route_page(stem, lines, alt, templates_dir,
                                                extra_anchor_lines=mt_lines)
            alt_tpl = load_template(alt, alt_page, templates_dir)
            if alt_tpl is not None:
                result["warnings"].append(f"FAMILY_LABEL_OVERRIDE({family}->{alt})")
                family, family_src = alt, "template_keywords"
                page, page_src = alt_page, alt_page_src
                result["controller_family"] = family
                result["page_type"] = page
                template = alt_tpl
    if template is None:
        # Unknown/variant screens are still useful as operator-reviewed drafts. Keep every
        # known-template path untouched and replace only the former hard reject here.
        generic_lines = lines
        if clahe_lines is not None:
            generic_lines, _ = merge_variant_lines(lines, clahe_lines)
        ext = extract_generic({**ocr_data, "lines": generic_lines}, meta["screen_size"], page)
        result["warnings"].append(f"GENERIC_FALLBACK({family},{page})")
        result["warnings"].extend(ext["warnings"])
        result["fields"] = ext["fields"]
        result["heater_columns"] = 0
        result["extraction_detail"] = ext["detail"]
        result["provenance"] = {
            "family_source": family_src,
            "page_source": page_src,
            "template": "generic.spatial",
            "ocr_file": str(ocr_path),
            "screen_size": meta["screen_size"],
            "rectify_method": meta.get("method"),
        }
        attach_contract(result)
        result["status"] = "review" if ext["fields"] else "reject"
        return result

    ui = template.get("ui_family")
    toks = norm_tokens(ocr_data, meta["screen_size"])
    clahe_stats = None
    rates_stats = None
    if ui in ("TACT", "KEBA", "B_AND_R", "FANUC", "DEMAG", "TRD6") and clahe_lines is not None:
        # 低对比白底框（TACT 保温行/KEBA 白底框）与蓝底白字（B_AND_R 整行漏检）
        # 召回补充：合并 CLAHE 变体 OCR（只加空位/高置信替换低置信的保守规则）
        merged_lines, clahe_stats = merge_variant_lines(ocr_data.get("lines", []), clahe_lines)
        toks = norm_tokens({**ocr_data, "lines": merged_lines}, meta["screen_size"])
    if ui == "DEMAG":
        # 列顶速率蓝框召回补充（026 S7c）：HSV 单格识别旁车带 _src 标记直接并入，
        # 不走 merge_variant_lines 的保守替换（速率格位置精确，由 demag 提取器优先采信）
        # 083 S03：温度页再并入逐格重读旁车（ocr_tcells，demag_cell）——
        # 整机照片竖向粘连格/整格漏读的补救，提取器仅在主 OCR 缺格/越界时采信。
        extra_lines = []
        rates_path = rectified_dir / f"{stem}.ocr_rates.json"
        if rates_path.is_file():
            rate_lines = json.loads(rates_path.read_text()).get("lines", [])
            for l in rate_lines:
                l["_src"] = "rate_cell"
            extra_lines += rate_lines
            rates_stats = {"rate_cells": len(rate_lines)}
        tcells_path = rectified_dir / f"{stem}.ocr_tcells.json"
        if page == "temperature" and tcells_path.is_file():
            extra_lines += json.loads(tcells_path.read_text()).get("lines", [])
        if extra_lines:
            base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
            toks = norm_tokens({**ocr_data, "lines": base_lines + extra_lines},
                               meta["screen_size"])
    if ui == "B_AND_R" and page == "temperature":
        # 083 S03：B&R 灰底温度表逐格重读旁车（br_cell），同 DEMAG 口径并入
        tcells_path = rectified_dir / f"{stem}.ocr_tcells.json"
        if tcells_path.is_file():
            cell_lines = json.loads(tcells_path.read_text()).get("lines", [])
            base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
            toks = norm_tokens({**ocr_data, "lines": base_lines + cell_lines},
                               meta["screen_size"])
    if ui == "ZizES" and page == "temperature":
        # 083 S13：ZizES 温度表逐格重读旁车（zizes_cell），同 B&R 口径并入；
        # 同格冲突由 extract_temperature 的「小数完整前缀」规则裁决
        # （主 OCR 截尾 '290' vs 旁车 '290.2' 时采信旁车）。
        tcells_path = rectified_dir / f"{stem}.ocr_tcells.json"
        if tcells_path.is_file():
            cell_lines = json.loads(tcells_path.read_text()).get("lines", [])
            toks = norm_tokens({**ocr_data,
                                "lines": ocr_data.get("lines", []) + cell_lines},
                               meta["screen_size"])
    if ui == "DEMAG" and page == "injection_metering":
        # 037 方案①：曲线页段表列网格旁车（带 slot 标记直接并入）
        # 033_FIX 修复3：旁车为 rec-only 重建变体，标 _src="ocr_variant"——
        # 与主 OCR 同格异值冲突时主 OCR 值优先（rank02 '004500' 实测）
        # 034_FIX：摩尔纹低通变体旁车（ocr_variants.moire_suppress，治段表
        # 相邻格粘连漏读）同机制并入，同格冲突主 OCR 值优先
        extra_lines = []
        for sidecar in ("ocr_stage", "ocr_moire"):
            sc_path = rectified_dir / f"{stem}.{sidecar}.json"
            if sc_path.is_file():
                for l in json.loads(sc_path.read_text()).get("lines", []):
                    l["_src"] = "ocr_variant"
                    extra_lines.append(l)
        if extra_lines:
            base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
            toks = norm_tokens({**ocr_data, "lines": base_lines + extra_lines},
                               meta["screen_size"])
    if ui == "FANUC":
        # 低质图整屏放大 OCR 变体召回补充（026 S7c）
        base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
        zoom_path = rectified_dir / f"{stem}.ocr_zoom.json"
        if zoom_path.is_file():
            zoom_lines = json.loads(zoom_path.read_text()).get("lines", [])
            merged_zoom, rates_stats = merge_variant_lines(base_lines, zoom_lines)
            base_lines = merged_zoom
            toks = norm_tokens({**ocr_data, "lines": base_lines}, meta["screen_size"])
        cells_path = rectified_dir / f"{stem}.ocr_cells.json"
        if cells_path.is_file():
            cell_lines = json.loads(cells_path.read_text()).get("lines", [])
            toks = norm_tokens({**ocr_data, "lines": base_lines + cell_lines},
                               meta["screen_size"])
    if ui == "ARBURG":
        # 延迟时间灰框旁车（049 A7）：带 _src 标记直接并入
        delay_path = rectified_dir / f"{stem}.ocr_delay.json"
        if delay_path.is_file():
            delay_lines = json.loads(delay_path.read_text()).get("lines", [])
            base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
            toks = norm_tokens({**ocr_data, "lines": base_lines + delay_lines},
                               meta["screen_size"])
    if ui == "TACT":
        # 设定行红框 HSV 旁车（033）：带 _src 标记直接并入，由 TACT 提取器定点使用；
        # 不写 provenance（保持 Z022 既有产物零 diff）
        setrow_path = rectified_dir / f"{stem}.ocr_setrow.json"
        if setrow_path.is_file():
            set_lines = json.loads(setrow_path.read_text()).get("lines", [])
            for l in set_lines:
                l["_src"] = "set_cell"
            base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
            toks = norm_tokens({**ocr_data, "lines": base_lines + set_lines},
                               meta["screen_size"])
    template_page_key = template.get("page")
    if template_page_key == "hot_runner_temp":
        # 热流道 SV 弱读格旁车（049 B4 s64）：带 _src 标记直接并入
        hr_path = rectified_dir / f"{stem}.ocr_hr.json"
        if hr_path.is_file():
            hr_lines = json.loads(hr_path.read_text()).get("lines", [])
            base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
            toks = norm_tokens({**ocr_data, "lines": base_lines + hr_lines},
                               meta["screen_size"])
    if template_page_key == "mold_temp":
        # 模温机数码管旁车（042 S04）：bbox 为各源图 0-1 分数坐标，换算到屏幕
        # 框架后并入；_src 区分坐标系（mt_cell=矫正图 / mt_cell_orig=原图 /
        # mt_full=原图全量 OCR），提取器按 src 分系聚行，不跨系混合
        if mt_lines:
            dst_w, dst_h = meta["screen_size"]
            for l in mt_lines:
                b = l["bbox"]
                b["points"] = [[px * dst_w, py * dst_h] for px, py in b["points"]]
                b["x_min"], b["x_max"] = b["x_min"] * dst_w, b["x_max"] * dst_w
                b["y_min"], b["y_max"] = b["y_min"] * dst_h, b["y_max"] * dst_h
            base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
            toks = norm_tokens({**ocr_data, "lines": base_lines + mt_lines},
                               meta["screen_size"])
    page_key = template_page_key
    if page_key == "injection_metering" and ui == "TACT":
        ext = extract_injection_tact(toks, template)
    elif page_key == "injection_metering" and ui == "DEMAG":
        # Layer 1 禁用段图像观测：矫正 PNG 存在时传入（缺失则优雅降级，无观测输出）
        png_path = rectified_dir / f"{stem}.png"
        ext = extract_injection_demag(toks, template,
                                      image_path=png_path if png_path.is_file() else None)
    elif page_key == "injection_metering" and ui == "FANUC":
        ext = extract_injection_fanuc(toks, template)
    elif page_key == "injection_metering" and ui == "ZIZES":
        ext = extract_injection_zizes(toks, template)
    elif page_key == "injection_metering" and ui == "KEBA":
        ext = extract_injection_keba(toks, template)
    elif page_key == "injection_metering" and ui == "B_AND_R":
        ext = extract_injection_b_and_r(toks, template)
    elif page_key == "injection_metering" and ui == "KAIMING":
        ext = extract_injection_kaiming(toks, template)
    elif page_key == "injection_metering" and ui == "EST":
        ext = extract_injection_est(toks, template)
    elif page_key == "injection_metering" and ui == "TRD6":
        ext = extract_injection_trd6(toks, template)
    elif page_key == "injection_metering" and ui == "ARBURG":
        ext = extract_injection_arburg(toks, template)
    elif page_key == "molding_monitor" and ui == "FANUC":
        ext = extract_molding_monitor_fanuc(toks, template)
    elif page_key == "waveform" and ui == "FANUC":
        ext = extract_waveform_fanuc(toks, template)
    elif page_key == "hot_runner_temp" and ui == "TACT":
        # 057 S02 动态槽位：黑屏（blackout）图像确认需矫正图探测显示区，
        # 缺失时优雅降级 unreadable（同 DEMAG Layer 1 先例，不传则不出 blackout）
        png_path = rectified_dir / f"{stem}.png"
        ext = extract_hot_runner_tact(
            toks, template, image_path=png_path if png_path.is_file() else None)
    elif page_key == "mold_temp" and ui == "FANUC":
        ext = extract_mold_temp_fanuc(toks, template)
    elif page_key == "mold_temp" and ui == "OMRON_E5CC":
        ext = extract_mold_temp_omron_e5cc(toks, template)
    elif page_key == "mold_temp" and ui == "MOLD_THERMOREGULATOR":
        ext = extract_mold_temp_thermoregulator(toks, template)
    elif page_key == "mold_temp" and ui == "INDUSTRIAL_CHILLER":
        ext = extract_mold_temp_industrial_chiller(toks, template)
    elif ui == "TACT":
        ext = extract_temperature_tact(toks, template)
    elif ui == "KEBA":
        ext = extract_temperature_keba(toks, template)
    elif ui == "B_AND_R":
        ext = extract_temperature_b_and_r(toks, template)
    elif ui == "FANUC":
        ext = extract_temperature_fanuc(toks, template)
    elif ui == "DEMAG":
        ext = extract_temperature_demag(toks, template)
    elif ui == "KAIMING":
        ext = extract_temperature_kaiming(toks, template)
    elif ui == "EST":
        ext = extract_temperature_est(toks, template)
    elif ui == "TRD6":
        ext = extract_temperature_trd6(toks, template)
    else:
        ext = extract_temperature(toks, template)
    result["warnings"].extend(ext["warnings"])
    result["heater_columns"] = ext["heater_columns"]
    result["fields"] = ext["fields"]
    result["provenance"] = {
        "family_source": family_src,
        "page_source": page_src,
        "template": f"{family.lower()}.{page}.json v{template['version']}",
        "ocr_file": str(ocr_path),
        "screen_size": meta["screen_size"],
        "rectify_method": meta.get("method"),
    }
    if clahe_stats is not None:
        result["provenance"]["ocr_clahe_merge"] = clahe_stats
    if rates_stats is not None:
        result["provenance"]["ocr_rates_merge"] = rates_stats
    result["extraction_detail"] = ext["detail"]
    attach_contract(result)

    if ext["fields"] is None:
        result["status"] = "reject"
    elif result["warnings"]:
        result["status"] = "review"
    else:
        result["status"] = "ok"
    return result


def main():
    ap = argparse.ArgumentParser(description="S4 字段提取（OCR + 归一化模板）")
    ap.add_argument("stems", nargs="*", help="要提取的 stem（output/rectified/<stem>.*）")
    ap.add_argument("--all", action="store_true", help="处理 rectified-dir 下全部 *.rectify.json")
    ap.add_argument("--rectified-dir", default="output/rectified")
    ap.add_argument("--output-dir", default="output/extracted")
    ap.add_argument("--record-report", default=str(RECORD_REPORT))
    ap.add_argument("--labels", default=str(MACHINE_LABELS))
    ap.add_argument("--templates-dir", default=str(TEMPLATES_DIR))
    args = ap.parse_args()

    rectified_dir = Path(args.rectified_dir)
    stems = list(args.stems)
    if args.all:
        stems += sorted(p.name[: -len(".rectify.json")] for p in rectified_dir.glob("*.rectify.json"))
    stems = sorted(set(stems))
    if not stems:
        sys.exit("[extract] ERROR: 没有可处理的 stem（用 --all 或显式指定）")

    record_report = json.loads(Path(args.record_report).read_text()) \
        if Path(args.record_report).is_file() else None
    machine_labels = json.loads(Path(args.labels).read_text()) \
        if Path(args.labels).is_file() else None

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = {"ok": 0, "review": 0, "reject": 0}
    for stem in stems:
        r = extract_one(stem, rectified_dir, record_report, machine_labels, Path(args.templates_dir))
        counts[r["status"]] += 1
        out_path = out_dir / f"{stem}.fields.json"
        out_path.write_text(json.dumps(r, ensure_ascii=False, indent=2))
        print(f"[extract] {stem}: {r['status']} warnings={r['warnings']}")
    print(f"[extract] done: ok={counts['ok']} review={counts['review']} reject={counts['reject']} -> {out_dir}")


if __name__ == "__main__":
    main()
