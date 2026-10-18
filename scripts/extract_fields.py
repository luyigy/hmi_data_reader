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
from extractor_registry import capabilities, extract_registered, template_error  # noqa: E402
from extract_families.common import _anchor_hits  # noqa: E402

TEMPLATES_DIR = Path("templates")
RECORD_REPORT = Path("output/record_classify_report.json")
MACHINE_LABELS = Path("ground_truth/machine_labels.json")

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
    家族此前永远无法走该兜底（整族 unknown 误拒）。优先锚点组更多的模板；
    同分时保持既有的模板文件名序。"""
    texts = [l["text"] for l in lines]
    paths = set(Path(templates_dir).glob("*.json"))
    registry = Path(templates_dir).parent / "contracts" / "profiles.json"
    if registry.is_file():
        for profile in json.loads(registry.read_text()).get("profiles", []):
            if profile.get("template"):
                paths.add(Path(templates_dir) / profile["template"])
    matches = []
    for tpl_path in sorted(paths):
        try:
            tpl = json.loads(tpl_path.read_text())
        except Exception:
            continue
        groups = tpl.get("family_detect_groups")
        if not groups:
            continue
        if all(_anchor_hits(g, texts) for g in groups):
            matches.append((len(groups), tpl.get("ui_family")))
    if not matches:
        return None
    return max(matches, key=lambda item: item[0])[1]


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
    # TACT 温度页在摩尔纹下品牌与整列行标签可能全丢，但四个连续区段列头仍在。
    texts = [line["text"] for line in lines]
    if all(_anchor_hits(anchor, texts) for anchor in ("前部", "中部", "后部", "下口")):
        return "TACT", "temperature_columns"
    # 3. 单图兜底
    fam, _ = find_ui_family(lines)
    return fam, "per_image_classify"


from page_template_registry import (BLOCKED_PAGE_SOURCES, resolve_page_template,
                                    route_page, load_template)  # noqa: E402

# ---------------------------------------------------------------- 提取

def norm_tokens(ocr_data: dict, screen_size: list[int]) -> list[dict]:
    """OCR 原始 lines -> 屏幕归一化坐标的 token 列表。"""
    W, H = screen_size
    toks = []
    for index, l in enumerate(ocr_data.get("lines", [])):
        b = l["bbox"]
        toks.append({
            "text": l["text"],
            "conf": float(l["conf"]),
            "x": ((b["x_min"] + b["x_max"]) / 2) / W,
            "y": ((b["y_min"] + b["y_max"]) / 2) / H,
            "x0": b["x_min"] / W,
            "x1": b["x_max"] / W,
            "src": l.get("_src"),
            "bbox": [b["x_min"], b["y_min"], b["x_max"], b["y_max"]],
            "line_index": index,
        })
    return toks


from extract_families.zizes_temperature import (  # noqa: E402
    detect_columns, deskew_slope, extract_temperature,
)


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


from extract_families.tact_temperature import extract_temperature_tact  # noqa: E402


# ---------------------------------------------------------------- 家族提取器（026 S7 拆出）
from extract_families.keba import extract_temperature_keba  # noqa: E402
from extract_families.b_and_r import extract_temperature_b_and_r  # noqa: E402
from extract_families.fanuc import extract_temperature_fanuc  # noqa: E402
from extract_families.demag import extract_demag  # noqa: E402
from extract_families.tact_injection import extract_injection_tact  # noqa: E402
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


def extract_page_fields(toks: list[dict], template: dict, *, ocr_lines: list[dict] | None = None,
                        meta: dict | None = None, image_path: Path | None = None) -> dict:
    """Select one extractor for all Reader entry points; callers prepare their own OCR evidence."""
    page = template.get("page")
    ui = template.get("ui_family")
    error = template_error(template)
    if error:
        return dict(fields=None, heater_columns=0, warnings=[error], detail={})
    if template.get("extractor") == "registered_extractor":
        return extract_registered(toks, template, ocr_lines=ocr_lines, meta=meta, image_path=image_path)
    if template.get("extractor") == "page_module":
        from importlib import import_module
        profile_id = template.get("profile_id", "")
        if not isinstance(profile_id, str) or not re.fullmatch(r"[a-z0-9_]+(?:\.[a-z0-9_]+){2}", profile_id):
            return dict(fields=None, heater_columns=0, warnings=["PAGE_EXTRACTOR_INVALID"], detail={})
        module_name = "extract_families.pages." + profile_id.replace(".", "_")
        try:
            module = import_module(module_name)
        except ModuleNotFoundError as exc:
            if exc.name != module_name:
                raise
            return dict(fields=None, heater_columns=0, warnings=["PAGE_EXTRACTOR_MISSING"], detail={})
        return module.extract(ocr_lines or [], template, meta or {}, image_path=image_path)
    if template.get("profile_id") == "tact5.process_settings.injection_holding_metering":
        from extract_families.tact5_process import extract_tact5
        return extract_tact5(ocr_lines or [], template, meta or {}, image_path=image_path)
    if page == "injection_metering":
        extractors = {
            "TACT": extract_injection_tact, "DEMAG": extract_demag,
            "FANUC": extract_injection_fanuc, "ZIZES": extract_injection_zizes,
            "KEBA": extract_injection_keba, "B_AND_R": extract_injection_b_and_r,
            "KAIMING": extract_injection_kaiming, "EST": extract_injection_est,
            "TRD6": extract_injection_trd6, "ARBURG": extract_injection_arburg,
        }
        extractor = extractors.get(str(ui).upper())
        if extractor:
            return (extractor(toks, template, image_path=image_path) if ui == "DEMAG"
                    else extractor(toks, template))
    if page == "molding_monitor" and ui == "FANUC":
        return extract_molding_monitor_fanuc(toks, template)
    if page == "waveform" and ui == "FANUC":
        return extract_waveform_fanuc(toks, template)
    if page == "hot_runner_temp" and ui == "TACT":
        return extract_hot_runner_tact(toks, template, image_path=image_path)
    if page == "mold_temp":
        mold_extractors = {
            "FANUC": extract_mold_temp_fanuc, "OMRON_E5CC": extract_mold_temp_omron_e5cc,
            "MOLD_THERMOREGULATOR": extract_mold_temp_thermoregulator,
            "INDUSTRIAL_CHILLER": extract_mold_temp_industrial_chiller,
        }
        extractor = mold_extractors.get(ui)
        if extractor:
            return extractor(toks, template)
    temperature_extractors = {
        "TACT": extract_temperature_tact, "KEBA": extract_temperature_keba,
        "B_AND_R": extract_temperature_b_and_r, "FANUC": extract_temperature_fanuc,
        "DEMAG": extract_demag, "KAIMING": extract_temperature_kaiming,
        "EST": extract_temperature_est, "TRD6": extract_temperature_trd6,
    }
    return temperature_extractors.get(ui, extract_temperature)(toks, template)


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
    if family == "unknown":
        # 伯乐 KEBA/B_AND_R 等无 record/机台先验且单图关键词分类失败的图：
        # 合并 CLAHE 变体后按各模板的 family_detect_groups 判族（不改既有路由优先级）
        det_lines = lines
        if clahe_lines is not None:
            det_lines, _ = merge_variant_lines(lines, clahe_lines)
        fam = detect_family_from_templates(det_lines + mt_lines, templates_dir)
        if fam:
            family, family_src = fam, "template_keywords"
        elif lcd_pv_set:
            family, family_src = "INDUSTRIAL_CHILLER", "mold_temp_lcd_signature"
    page, page_src, template = resolve_page_template(
        stem, lines, family, templates_dir, extra_anchor_lines=mt_lines)
    if family_src == "mold_temp_lcd_signature":
        page, page_src = "mold_temp", "mold_temp_lcd_signature"
        template = load_template(family, page, templates_dir, lines=lines)
    result["controller_family"] = family
    result["page_type"] = page
    if page_src in BLOCKED_PAGE_SOURCES:
        result["warnings"].append(BLOCKED_PAGE_SOURCES[page_src])
        return result
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
            alt_page, alt_page_src, alt_tpl = resolve_page_template(
                stem, lines, alt, templates_dir, extra_anchor_lines=mt_lines)
            if alt_page_src in BLOCKED_PAGE_SOURCES:
                result["warnings"].append(BLOCKED_PAGE_SOURCES[alt_page_src])
                return result
            if alt_tpl is not None:
                result["warnings"].append(f"FAMILY_LABEL_OVERRIDE({family}->{alt})")
                family, family_src = alt, "template_keywords"
                page, page_src = alt_page, alt_page_src
                result["controller_family"] = family
                result["page_type"] = page
                template = alt_tpl
    if template is None:
        # Unrecognized screens retain observations for operator review.
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
    if template.get("profile_id"):
        result["controller_family"] = family = ui
        result["page_type"] = page = template["page"]
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
    png_path = rectified_dir / f"{stem}.png"
    ext = extract_page_fields(toks, template, ocr_lines=ocr_data.get("lines", []), meta=meta,
                              image_path=png_path if png_path.is_file() else None)
    result["warnings"].extend(ext["warnings"])
    result["heater_columns"] = ext["heater_columns"]
    result["fields"] = ext["fields"]
    result["provenance"] = {
        "family_source": family_src,
        "page_source": page_src,
        "template": f"{template.get('profile_id', family.lower() + '.' + page)}.json v{template['version']}",
        "ocr_file": str(ocr_path),
        "screen_size": meta["screen_size"],
        "rectify_method": meta.get("method"),
    }
    result["template_name"] = f"{template.get('profile_id', family.lower() + '.' + page)}.json"
    result["template_version"] = template["version"]
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
    ap.add_argument("--capabilities", action="store_true", help="输出受控提取能力目录 JSON")
    args = ap.parse_args()
    if args.capabilities:
        print(json.dumps(capabilities(), ensure_ascii=False))
        return

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
