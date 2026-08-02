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
    不影响 ZizES/TACT 等既有路由。"""
    texts = [l["text"] for l in lines]
    for tpl_path in sorted(Path(templates_dir).glob("*.temperature.json")):
        try:
            tpl = json.loads(tpl_path.read_text())
        except Exception:
            continue
        groups = tpl.get("family_detect_groups")
        if not groups:
            continue
        if all(any(_anchor_match(g, t) for t in texts) for g in groups):
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
               templates_dir: Path = TEMPLATES_DIR) -> tuple[str, str]:
    """页面路由：结构锚点优先（该家族温度页模板的 油温列头 + 设定/控制行锚点
    同时在场），其次 classify_ui.find_page，最后文件名兜底。

    find_page 会被页内 '设定°C'/'控制%' 行标签与底部 Tab 干扰（实测 rec12 误判
    settings），所以温度页模板锚点命中时直接判 temperature。
    """
    tpl = load_template(family, "temperature", templates_dir) if family != "unknown" else None
    if tpl:
        anchors = tpl["row_anchors"]
        texts = [l["text"] for l in lines]
        # 模板可声明自己的页面检测锚点（TACT 无油温列头）；缺省保持 ZizES 口径
        # 锚点值为字符串或候选列表（KEBA 设定温度/温度设置 双子变体）
        keys = tpl.get("page_detect_anchors", ["oil_header", "set", "control"])
        if all(any(_anchor_match(anchors[k], t) for t in texts) for k in keys):
            return "temperature", "template_anchors"
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
        cols = [layout["column_x_centers"][str(i)] for i in range(1, 8)]
        warnings.append("TEMPLATE_COLUMNS_FALLBACK")
    if oil_x is None:
        oil_x = layout["column_x_centers"]["oil"]
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
    cells: dict[str, dict[int, dict]] = {r: {} for r in row_names}
    for t in value_tokens:
        r, c = row_of(t), col_of(t)
        if r and c:
            cells[r].setdefault(c, t)  # 同格多 token 取先到的（更高 conf 通常先检出）
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
            elif t is not None and t["conf"] < rules["min_cell_conf"]:
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
    - 无同位基础行：作为补充行追加（填补基础 OCR 漏检）。
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
            merged.append(dict(v))
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

    # 列位：区段中文列头实测；中间段整列不存在按实际段数提取（变体自适应，033）；
    # 边缘段（喷嘴/落下口）缺失按实测列距中位数外推（变体布局下模板坐标不可用）
    col_x: dict[str, float] = {}
    header_toks = []
    missing_labels = []
    for label in zones + [drop]:
        hits = [t for t in toks if label in t["text"]]
        if hits:
            col_x[label] = hits[0]["x"]
            header_toks.append(hits[0])
        else:
            missing_labels.append(label)
    mid_missing = [m for m in missing_labels if m in zones[1:-1]]
    if mid_missing and len(header_toks) >= 4:
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
                col_x[m] = xs[0] - gap
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
        hits = [t for t in toks if anchors[name] in t["text"]]
        if hits:
            row_y[name] = hits[0]["y2"]
            label_toks.append(hits[0])
        else:
            row_y[name] = layout["row_y_centers"][name]
            fallback_rows.append(name)
            warnings.append(f"ROW_LABEL_FALLBACK({name})")
    if len(label_toks) < 3:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"ROW_LABELS_NOT_FOUND({len(label_toks)})"], "detail": {}}
    if not (row_y["set"] < row_y["current"] < row_y["control"] < row_y["holding"]):
        warnings.append("ROW_ORDER_ABNORMAL")

    spacing = (col_x[drop] - col_x[zones[0]]) / len(zones)
    col_tol = min(layout["col_x_tolerance"], spacing / 2)
    row_tol = layout["row_y_tolerance"]

    # 数据区 token：去斜后落在 (列头行, 保温行+tol] 内，排除列头与行标签结构 token
    # （HSV 设定行旁车 set_cell 不参与通用 band，只在设定行缺格时定点补充）
    header_y = sum(t["y2"] for t in header_toks) / len(header_toks)
    struct_ids = {id(t) for t in header_toks + label_toks}
    band = [t for t in toks if header_y + 0.01 < t["y2"] <= row_y["holding"] + row_tol
            and id(t) not in struct_ids and t.get("src") != "set_cell"]

    # 单元格填充：cells[row][col_label] = token
    cells: dict[str, dict[str, dict]] = {r: {} for r in row_names}
    for t in band:
        r = min(row_names, key=lambda n: abs(t["y2"] - row_y[n]))
        if abs(t["y2"] - row_y[r]) > row_tol:
            continue
        c = min(col_x, key=lambda lb: abs(t["x"] - col_x[lb]))
        if abs(t["x"] - col_x[c]) > col_tol:
            continue
        cells[r].setdefault(c, t)  # 同格多 token 取先到的（OCR 按从上到下输出）
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

    def cell_number(row: str, col: str) -> tuple[float | None, dict | None]:
        t = cells[row].get(col)
        if t is None:
            return None, None
        m = NUM_RE.search(t["text"])
        if not m:
            return None, t
        raw = m.group()
        if "." not in raw and len(raw) == 4:
            raw = raw[:3] + "." + raw[3]  # OCR 丢小数点（2718->271.8）
        return float(raw), t

    def row_values(row: str, cols_needed: list[str]) -> tuple[list[float | None], list[str]]:
        vals, ws = [], []
        for c in cols_needed:
            v, t = cell_number(row, c)
            if v is None:
                ws.append(f"CELL_MISSING({row},{c})")
            elif t is not None and t["conf"] < rules["min_cell_conf"]:
                ws.append(f"LOW_CONF({row},{c},{t['conf']:.2f})")
            vals.append(v)
        return vals, ws

    setv, w1 = row_values("set", zones)
    cur, w2 = row_values("current", zones)
    ctl, w3 = row_values("control", zones)
    hold, w4 = row_values("holding", zones)
    drop_set, w5 = row_values("set", [drop])
    drop_cur, w6 = row_values("current", [drop])
    drop_ctl, w7 = row_values("control", [drop])
    warnings.extend(w1 + w2 + w3 + w4 + w5 + w6 + w7)

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
from extract_families.est_injection import extract_injection_est  # noqa: E402
from extract_families.trd6_injection import extract_injection_trd6  # noqa: E402
from extract_families.arburg_injection import extract_injection_arburg  # noqa: E402
from extract_families.keba_injection import extract_injection_keba  # noqa: E402
from extract_families.b_and_r_injection import extract_injection_b_and_r  # noqa: E402
from extract_families.kaiming_injection import extract_injection_kaiming  # noqa: E402
from extract_families.est_injection import extract_injection_est  # noqa: E402
from extract_families.trd6_injection import extract_injection_trd6  # noqa: E402
from extract_families.arburg_injection import extract_injection_arburg  # noqa: E402
from extract_families.b_and_r_injection import extract_injection_b_and_r  # noqa: E402
from extract_families.kaiming_injection import extract_injection_kaiming  # noqa: E402
from extract_families.est_injection import extract_injection_est  # noqa: E402
from extract_families.trd6_injection import extract_injection_trd6  # noqa: E402
from extract_families.arburg_injection import extract_injection_arburg  # noqa: E402


# ---------------------------------------------------------------- 主流程
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
    if family == "unknown":
        # 伯乐 KEBA/B_AND_R 等无 record/机台先验且单图关键词分类失败的图：
        # 合并 CLAHE 变体后按各模板的 family_detect_groups 判族（不改既有路由优先级）
        det_lines = lines
        if clahe_lines is not None:
            det_lines, _ = merge_variant_lines(lines, clahe_lines)
        fam = detect_family_from_templates(det_lines, templates_dir)
        if fam:
            family, family_src = fam, "template_keywords"
    page, page_src = route_page(stem, lines, family, templates_dir)
    result["controller_family"] = family
    result["page_type"] = page
    result["hmi_variant"] = "v1"

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
    if template is None:
        result["warnings"].append(f"NO_TEMPLATE({family},{page})")
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
        rates_path = rectified_dir / f"{stem}.ocr_rates.json"
        if rates_path.is_file():
            rate_lines = json.loads(rates_path.read_text()).get("lines", [])
            for l in rate_lines:
                l["_src"] = "rate_cell"
            base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
            rates_stats = {"rate_cells": len(rate_lines)}
            toks = norm_tokens({**ocr_data, "lines": base_lines + rate_lines},
                               meta["screen_size"])
    if ui == "DEMAG" and page == "injection_metering":
        # 037 方案①：曲线页段表列网格旁车（带 slot 标记直接并入）
        stage_path = rectified_dir / f"{stem}.ocr_stage.json"
        if stage_path.is_file():
            stage_lines = json.loads(stage_path.read_text()).get("lines", [])
            base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
            toks = norm_tokens({**ocr_data, "lines": base_lines + stage_lines},
                               meta["screen_size"])
    if ui == "FANUC":
        # 低质图整屏放大 OCR 变体召回补充（026 S7c）
        zoom_path = rectified_dir / f"{stem}.ocr_zoom.json"
        if zoom_path.is_file():
            zoom_lines = json.loads(zoom_path.read_text()).get("lines", [])
            base_lines = merged_lines if clahe_stats is not None else ocr_data.get("lines", [])
            merged_zoom, rates_stats = merge_variant_lines(base_lines, zoom_lines)
            toks = norm_tokens({**ocr_data, "lines": merged_zoom}, meta["screen_size"])
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
    page_key = template.get("page")
    if page_key == "injection_metering" and ui == "TACT":
        ext = extract_injection_tact(toks, template)
    elif page_key == "injection_metering" and ui == "DEMAG":
        ext = extract_injection_demag(toks, template)
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
