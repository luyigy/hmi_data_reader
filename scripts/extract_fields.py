"""Shared OCR-to-page extraction entry point. Only registered pages can emit fields."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from classify_ui import find_page, find_ui_family  # noqa: E402
from contract import attach_contract  # noqa: E402
from extractor_registry import capabilities, extract_registered, legacy_extractor_id, template_error  # noqa: E402
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
    """Use registered template evidence to narrow controller-family candidates."""
    texts = [line['text'] for line in lines]
    registry = Path(templates_dir).parent / 'contracts/profiles.json'
    profiles = json.loads(registry.read_text()).get('profiles', []) if registry.is_file() else []
    paths = {Path(templates_dir) / profile['template'] for profile in profiles if profile.get('template')}
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




def extract_page_fields(toks: list[dict], template: dict, *, ocr_lines: list[dict] | None = None,
                        meta: dict | None = None, image_path: Path | None = None) -> dict:
    """Select one extractor for all Reader entry points; callers prepare their own OCR evidence."""
    error = template_error(template)
    if error:
        return dict(fields=None, heater_columns=0, warnings=[error], detail={})
    if template.get("extractor") == "registered_extractor":
        return extract_registered(toks, template, ocr_lines=ocr_lines, meta=meta, image_path=image_path)
    legacy_id = legacy_extractor_id(template)
    if legacy_id:
        return extract_registered(toks, {**template, "extractor_id": legacy_id},
                                  ocr_lines=ocr_lines, meta=meta, image_path=image_path)
    return dict(fields=None, heater_columns=0, warnings=["PAGE_UNSUPPORTED"], detail={})


def extract_one(stem: str, rectified_dir: Path, record_report: dict | None,
                machine_labels: dict | None, templates_dir: Path,
                controller_hint: dict | None = None) -> dict:
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
    if controller_hint is not None:
        from controller_binding import parse_hint
        try:
            controller_hint = parse_hint(controller_hint)
        except (ValueError, TypeError):
            result.update(compatibility={"status": "incompatible", "code": "CONTROLLER_HINT_INVALID"})
            result["warnings"].append("CONTROLLER_HINT_INVALID")
            return result
    from page_identity import PLUGINS, route_identities
    identity = route_identities(lines)
    if identity['status'] == 'ambiguous':
        result.update(page_routing=identity, page_type='unknown', controller_family='unknown',
            compatibility={'status': 'conflict', 'code': 'PAGE_TEMPLATE_CONFLICT'},
            provenance={'page_source': 'ambiguous_page_identity', 'screen_size': meta['screen_size']})
        result['warnings'].append('PAGE_TEMPLATE_CONFLICT')
        return result
    family, family_src = route_family(stem, lines, record_report, machine_labels)
    clahe_path = rectified_dir / f"{stem}.ocr_clahe.json"
    clahe_lines = None
    if clahe_path.is_file():
        clahe_lines = json.loads(clahe_path.read_text()).get("lines", [])
    mt_lines = []
    if family == "unknown":
        # 伯乐 KEBA/B_AND_R 等无 record/机台先验且单图关键词分类失败的图：
        # 合并 CLAHE 变体后按各模板的 family_detect_groups 判族（不改既有路由优先级）
        det_lines = lines
        if clahe_lines is not None:
            det_lines, _ = merge_variant_lines(lines, clahe_lines)
        fam = (next(c['family'] for c in identity['candidates'] if c['matched'] and not c['conflicts'])
               if identity['status'] == 'matched' else
               detect_family_from_templates(det_lines + mt_lines, templates_dir))
        if fam:
            family, family_src = fam, "template_keywords"
    page, page_src, template = resolve_page_template(
        stem, lines, family, templates_dir, extra_anchor_lines=mt_lines)
    if controller_hint is not None:
        from controller_binding import select_bound_page
        evidence = lines + mt_lines
        image_family, _ = route_family("", evidence, None, None)
        detected = detect_family_from_templates(evidence, templates_dir)
        page, page_src, template, receipt = select_bound_page(
            controller_hint, evidence, image_family, templates_dir, detected_family=detected)
        if template is None:
            receipt.update(status={"PAGE_UNKNOWN": "unknown", "CONTROLLER_UNKNOWN": "unknown",
                                   "PAGE_TEMPLATE_DISABLED": "disabled",
                                   "PAGE_BINDING_MISMATCH": "conflict",
                                   "PAGE_TEMPLATE_CONFLICT": "conflict"}.get(page_src, "incompatible"),
                           code=page_src)
            result.update(compatibility=receipt, page_type=page, controller_family=image_family)
            result["warnings"].append(page_src)
            return result
        family, family_src = template["ui_family"], "controller_binding"
        result["compatibility"] = receipt
    result["controller_family"] = family
    result["page_type"] = page
    routing = route_identities(lines, family)
    if template is not None and template.get('profile_id') not in PLUGINS:
        routing = route_identities(lines, family, profile_ids=[template.get('profile_id')])
        routing['legacy_profile_id'] = template.get('profile_id')
        routing['compatibility_path'] = page_src
    if page_src in BLOCKED_PAGE_SOURCES:
        if page_src == 'ambiguous_template_anchors':
            routing.update(status='ambiguous', profile_id=None)
        routing['selection_error'] = BLOCKED_PAGE_SOURCES[page_src]
    result['page_routing'] = routing
    if (template is not None and template.get('profile_id') in PLUGINS
            and (routing['status'] != 'matched' or routing['profile_id'] != template['profile_id'])):
        result['warnings'].append('PAGE_IDENTITY_UNVERIFIED')
        result['compatibility'] = {'status': 'unknown', 'code': 'PAGE_UNKNOWN'}
        return result
    if page_src in BLOCKED_PAGE_SOURCES:
        result['provenance'] = dict(family_source=family_src, page_source=page_src,
                                    screen_size=meta['screen_size'])
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
                result['page_routing'] = route_identities(lines, family,
                    profile_ids=[template.get('profile_id')])
    if template is None:
        result.update(page_routing={**result['page_routing'], 'status': 'unsupported', 'profile_id': None},
                      compatibility={'status': 'unsupported', 'code': 'PAGE_UNSUPPORTED'})
        result['warnings'].append('PAGE_UNSUPPORTED')
        result['provenance'] = dict(family_source=family_src, page_source=page_src,
                                    screen_size=meta['screen_size'])
        return result

    ui = template.get("ui_family")
    if template.get("profile_id"):
        result["controller_family"] = family = ui
        result["page_type"] = page = template["page"]
    toks = norm_tokens(ocr_data, meta["screen_size"])
    clahe_stats = None
    rates_stats = None
    if ui == "B_AND_R" and clahe_lines is not None:
        # 低对比白底框（TACT 保温行/KEBA 白底框）与蓝底白字（B_AND_R 整行漏检）
        # 召回补充：合并 CLAHE 变体 OCR（只加空位/高置信替换低置信的保守规则）
        merged_lines, clahe_stats = merge_variant_lines(ocr_data.get("lines", []), clahe_lines)
        toks = norm_tokens({**ocr_data, "lines": merged_lines}, meta["screen_size"])
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
    ap.add_argument("--observations-version", choices=("v1", "v2"), default="v1")
    ap.add_argument("--original-image", type=Path, help="v2 requires the actual source image")
    ap.add_argument("--controller-hint", type=Path, help="JSON pinned controller binding")
    args = ap.parse_args()
    controller_hint = None
    if args.controller_hint:
        from controller_binding import parse_hint
        try:
            controller_hint = parse_hint(args.controller_hint.read_text())
        except (OSError, ValueError, TypeError):
            ap.error("CONTROLLER_HINT_INVALID")
    if args.observations_version == "v2" and (not args.original_image or len(args.stems) != 1 or args.all):
        ap.error("v2 requires one stem and --original-image")
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
        r = extract_one(stem, rectified_dir, record_report, machine_labels, Path(args.templates_dir),
                        controller_hint=controller_hint)
        if args.observations_version == "v2":
            import hashlib
            import cv2
            from raw_observations import (observe_temperature_time_page, select_raw_profile,
                                          RawPageRejected)
            try:
                raw_profile = select_raw_profile(r.get("profile_id"), json.loads(
                    (rectified_dir / f"{stem}.ocr.json").read_text())["lines"])
            except ValueError:
                ap.error(next((warning for warning in r.get("warnings", [])
                               if warning in BLOCKED_PAGE_SOURCES.values()), "RAW_PAGE_UNSUPPORTED"))
            original_bytes = args.original_image.read_bytes()
            original = cv2.imread(str(args.original_image))
            meta = json.loads((rectified_dir / f"{stem}.rectify.json").read_text())
            if original is None or list(reversed(original.shape[:2])) != meta.get("original_size"):
                ap.error("Original image dimensions disagree with rectification evidence")
            if meta.get("original_sha256") != hashlib.sha256(original_bytes).hexdigest():
                ap.error("Original image hash disagrees with rectification evidence")
            ocr = json.loads((rectified_dir / f"{stem}.ocr.json").read_text())
            rectified = cv2.imread(str(rectified_dir / f"{stem}.png"), cv2.IMREAD_GRAYSCALE)
            try:
                r["page_observations"] = observe_temperature_time_page(
                    raw_profile, ocr["lines"], meta,
                    hashlib.sha256(original_bytes).hexdigest(),
                    rectified, package_root=Path(args.templates_dir).parent,
                    package_version=r.get("template_version", "1.0.0"))
            except RawPageRejected as exc:
                r.update(status="reject", fields=None, page_observations=None, raw_rejection=exc.detail)
                r.pop("extraction_detail", None)
                r["warnings"].append(exc.detail["code"])
            r["raw_ocr_evidence"] = ocr
            if r["page_observations"] is not None:
                r["page_observations"]["engine"] = ocr.get("engine_identity", {"library": "provided_ocr_sidecar", "version": ocr.get("model")})
        counts[r["status"]] += 1
        out_path = out_dir / f"{stem}.fields.json"
        out_path.write_text(json.dumps(r, ensure_ascii=False, indent=2))
        print(f"[extract] {stem}: {r['status']} warnings={r['warnings']}")
    print(f"[extract] done: ok={counts['ok']} review={counts['review']} reject={counts['reject']} -> {out_dir}")


if __name__ == "__main__":
    main()
