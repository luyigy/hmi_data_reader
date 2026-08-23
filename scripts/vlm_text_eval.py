"""离线评测 OCR token → catalog 字段映射；不读取原图、不接生产入口。"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from difflib import SequenceMatcher
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from extract_generic import NUMBER_RE, _norm, extract_generic  # noqa: E402
from extract_fields import extract_one, merge_variant_lines  # noqa: E402
from verify_accuracy import build_report, compare_one  # noqa: E402
from vlm_qwen import (VlmError, check_text_model, load_catalog,  # noqa: E402
                      map_text_evidence)


UNRESOLVED_GROUPS = {
    "barrel_temperature_rows": {
        "barrel_temperature_set_c", "barrel_temperature_current_c"},
}


def _text_eval_percentile(values: list[float], ratio: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[max(0, math.ceil(len(ordered) * ratio) - 1)], 3)


def _text_eval_sidecars(output_root: Path, selected: set[str]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for path in output_root.rglob("*.ocr.json"):
        case_id = path.name.removesuffix(".ocr.json")
        if case_id not in selected:
            continue
        current = result.get(case_id)
        if current is None or (path.stat().st_mtime_ns, str(path)) > (
                current.stat().st_mtime_ns, str(current)):
            result[case_id] = path
    return result


def _text_eval_ocr(path: Path, screen_size: list[int]) -> dict:
    """Load the same already-generated OCR supplements used by extraction."""
    ocr = json.loads(path.read_text(encoding="utf-8"))
    lines = ocr.get("lines", [])
    stem = path.name.removesuffix(".ocr.json")
    for suffix in ("ocr_clahe", "ocr_zoom"):
        extra_path = path.with_name(f"{stem}.{suffix}.json")
        if extra_path.is_file():
            extra = json.loads(extra_path.read_text(encoding="utf-8")).get("lines", [])
            lines, _ = merge_variant_lines(lines, extra)
    for suffix in ("ocr_rates", "ocr_tcells", "ocr_cells", "ocr_stage", "ocr_moire",
                   "ocr_delay", "ocr_setrow", "ocr_hr"):
        extra_path = path.with_name(f"{path.name.removesuffix('.ocr.json')}.{suffix}.json")
        if extra_path.is_file():
            extra = json.loads(extra_path.read_text(encoding="utf-8")).get("lines", [])
            if suffix == "ocr_rates":
                extra = [{**line, "_src": "rate_cell"} for line in extra]
            lines = lines + extra
    mt_path = path.with_name(f"{stem}.ocr_mt.json")
    if mt_path.is_file():
        width, height = screen_size
        mt = json.loads(mt_path.read_text(encoding="utf-8")).get("lines", [])
        for source in mt:
            line = {**source, "bbox": dict(source["bbox"])}
            box = line["bbox"]
            box["points"] = [[x * width, y * height] for x, y in box["points"]]
            for key, scale in (("x_min", width), ("x_max", width),
                               ("y_min", height), ("y_max", height)):
                box[key] *= scale
            lines.append(line)
    return {**ocr, "lines": lines}


def _catalog_unresolved(evidence: dict, catalog: dict,
                        resolved: set[str]) -> list[dict]:
    """Find catalog fields whose OCR label exists but value/shape is uncertain."""
    page_type = evidence.get("page_type")
    tokens = evidence.get("tokens") or {}
    rows = evidence.get("rows") or []
    candidates = []
    for field, meta in catalog.get("fields", {}).items():
        if (field in resolved or page_type not in (meta.get("source_pages") or [])
                or not str(meta.get("value_type", "")).startswith(("float", "int", "list"))):
            continue
        label = _norm(str(meta.get("label_zh") or ""))
        if not label:
            continue
        label_ids, fragments = [], set()
        for token_id, token in tokens.items():
            text = _norm(str(token.get("text") or ""))
            match = SequenceMatcher(None, label, text).find_longest_match()
            if match.size >= 2:
                label_ids.append(token_id)
                fragments.add(label[match.a:match.a + match.size])
        direct = any(label in _norm(str(row.get("text") or "")) for row in rows)
        if not direct and len(fragments) < 2:
            continue

        expect_list = str(meta.get("value_type", "")).startswith("list")
        raw_unit = str(meta.get("unit") or "").lower()
        unit = re.sub(r"[^a-z]", "", raw_unit)
        value_ids = []
        for row in rows:
            row_text = _norm(str(row.get("text") or ""))
            if not any(fragment in row_text for fragment in fragments):
                continue
            if ((raw_unit == "%" and "%" not in row_text)
                    or (len(unit) >= 3
                        and unit not in re.sub(r"[^a-z]", "", row_text.lower()))):
                continue
            row_ids = row.get("value_token_ids") or []
            count = sum(len(NUMBER_RE.findall(str(tokens.get(token_id, {}).get("text", ""))))
                        for token_id in row_ids)
            if (expect_list and count >= 2) or (not expect_list and count == 1):
                value_ids.extend(row_ids)
        if value_ids:
            candidates.append({
                "field": field,
                "reason": "CATALOG_LABEL_VALUE_OR_STRUCTURE_UNCERTAIN",
                "label_token_ids": list(dict.fromkeys(label_ids)),
                "value_token_ids": list(dict.fromkeys(value_ids)),
            })
    return candidates


def _unresolved_request(generic: dict, catalog: dict) -> tuple[dict, set[str]]:
    """Keep only unresolved catalog fields and their OCR rows/tokens."""
    detail = generic["detail"]
    evidence = detail["evidence"]
    page_type = evidence.get("page_type")
    page_fields = {key for key, meta in catalog.get("fields", {}).items()
                   if page_type in (meta.get("source_pages") or [])}
    requested: set[str] = set()
    seed_ids: set[str] = set()
    unresolved = list(detail.get("unresolved", []))
    unresolved += _catalog_unresolved(evidence, catalog, set(generic.get("fields") or {}))
    for item in unresolved:
        requested.update(UNRESOLVED_GROUPS.get(item.get("field"), {item.get("field")}))
        seed_ids.update(item.get("label_token_ids") or [])
        seed_ids.update(item.get("value_token_ids") or [])
    requested &= page_fields - set(generic.get("fields") or {})
    used_ids = {token_id for mapping in detail.get("mappings", [])
                for token_id in (mapping.get("label_token_ids") or [])
                + (mapping.get("value_token_ids") or [])}
    rows = [row for row in evidence.get("rows", [])
            if seed_ids.intersection((row.get("label_token_ids") or [])
                                     + (row.get("value_token_ids") or []))]
    token_ids = seed_ids | {token_id for row in rows
                            for token_id in (row.get("label_token_ids") or [])
                            + (row.get("value_token_ids") or [])}
    token_ids -= used_ids
    return {
        "page_type": page_type,
        "tokens": {key: value for key, value in evidence.get("tokens", {}).items()
                   if key in token_ids},
        "rows": rows,
        "supplements": {key: [token_id for token_id in token_ids_ if token_id in token_ids]
                        for key, token_ids_ in (evidence.get("supplements") or {}).items()},
    }, requested


def _merge_fields(deterministic: dict, vlm: dict) -> tuple[dict, dict]:
    added = {key: value for key, value in vlm.items() if key not in deterministic}
    return {**deterministic, **added}, added


def _hybrid_status(fields: dict, unresolved: set[str], vlm_used: bool) -> str:
    if not fields:
        return "reject"
    return "review" if unresolved or vlm_used else "ok"


def _field_matches(field: str, value, truth_fields: dict,
                   tolerances: dict[str, float]) -> bool:
    expected = truth_fields.get(field)
    if isinstance(expected, list):
        return (isinstance(value, list) and len(value) == len(expected)
                and all((actual is None and target is None)
                        or (isinstance(actual, (int, float))
                            and isinstance(target, (int, float))
                            and abs(actual - target) <= tolerances.get(field, 0.5))
                        for actual, target in zip(value, expected)))
    return (isinstance(expected, (int, float)) and isinstance(value, (int, float))
            and abs(value - expected) <= tolerances.get(field, 0.5))


def _add_contribution(target: dict, fields: dict, truth_fields: dict,
                      tolerances: dict[str, float]) -> None:
    target["fields"] += len(fields)
    correct = sum(_field_matches(field, value, truth_fields, tolerances)
                  for field, value in fields.items())
    target["correct_fields"] += correct
    target["error_fields"] += len(fields) - correct


def run_text_evaluation(baseline_path: Path, output_dir: Path,
                        catalog_path: Path, case_ids: list[str] | None = None) -> dict:
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    manifest_path = ROOT / baseline["samples"]["source"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    catalog = load_catalog(catalog_path)
    selected = case_ids or baseline["samples"]["replay_cases"]
    truth_paths = {
        item["case_id"]: ROOT / "datasets" / item["path"]
        for items in manifest["partitions"].values() for item in items
    }
    sidecars = _text_eval_sidecars(ROOT / "output", set(selected))
    scorable = {
        key: "numeric" for key, meta in catalog["fields"].items()
        if meta.get("value_type") in {"float", "int", "list[float]", "list[int]"}
    }
    tolerances = {key: meta.get("tolerance", 0.5)
                  for key, meta in catalog["fields"].items() if key in scorable}

    output_dir.mkdir(parents=True, exist_ok=True)
    per_image, vlm_latencies, deterministic_latencies, template_latencies = [], [], [], []
    usages, results = [], []
    parse_failures = illegal_references = mapped = expected = 0
    vlm_calls = 0
    model_checked = False
    lengths_ok = orders_ok = arrays_total = 0
    contribution = {
        source: {"fields": 0, "correct_fields": 0, "error_fields": 0}
        for source in ("deterministic", "template", "vlm")
    }
    with (output_dir / "results.jsonl").open("w", encoding="utf-8") as stream:
        for index, case_id in enumerate(selected, 1):
            truth_path = truth_paths.get(case_id)
            ocr_path = sidecars.get(case_id)
            if truth_path is None or ocr_path is None:
                raise VlmError(f"固定清单输入缺失：{case_id}")
            rectify_path = ocr_path.with_name(f"{case_id}.rectify.json")
            truth = yaml.safe_load(truth_path.read_text(encoding="utf-8"))
            rectify = json.loads(rectify_path.read_text(encoding="utf-8"))
            started = time.perf_counter()
            ocr = _text_eval_ocr(ocr_path, rectify["screen_size"])
            generic = extract_generic(ocr, rectify["screen_size"], truth["page_type"])
            deterministic_latencies.append(time.perf_counter() - started)
            generic["detail"]["evidence"]["supplements"] = {
                "rate_cell": [f"t{line_no}" for line_no, line in enumerate(ocr["lines"])
                              if line.get("_src") == "rate_cell"
                              and f"t{line_no}" in generic["detail"]["evidence"]["tokens"]]
            }
            fields = dict(generic.get("fields") or {})
            deterministic = set(fields)
            started = time.perf_counter()
            template_result = extract_one(case_id, ocr_path.parent, None, None,
                                          ROOT / "templates")
            template_latencies.append(time.perf_counter() - started)
            template_source = (template_result.get("provenance") or {}).get("template", "")
            template_input = (template_result.get("fields") or {}
                              if template_source != "generic.spatial" else {})
            fields, template_fields = _merge_fields(fields, template_input)
            hybrid = {**generic, "fields": fields or None}
            evidence, requested = _unresolved_request(hybrid, catalog)
            record = {"case_id": case_id, "page_type": truth["page_type"],
                      "deterministic_fields": sorted(deterministic),
                      "template_fields": sorted(template_fields),
                      "vlm_requested_fields": sorted(requested)}
            result = {"fields": {}, "mappings": [], "unresolved": []}
            if requested and evidence["tokens"]:
                try:
                    if not model_checked:
                        check_text_model()
                        model_checked = True
                    result = map_text_evidence(evidence, catalog, requested)
                    fields, vlm_fields = _merge_fields(fields, result["fields"])
                    record.update({"vlm_fields": sorted(vlm_fields),
                                   "mappings": result["mappings"],
                                   "vlm_unresolved": result["unresolved"],
                                   "latency_s": result["latency_s"], "usage": result["usage"]})
                    vlm_latencies.append(result["latency_s"])
                    vlm_calls += 1
                    if isinstance(result.get("usage"), dict):
                        usages.append(result["usage"])
                except VlmError as exc:
                    record["error"] = str(exc)
                    parse_failures += "JSON" in str(exc) or "响应结构" in str(exc)
                    illegal_references += any(word in str(exc) for word in
                                              ("未知", "重复", "越界", "直接数值",
                                               "引用结构", "歧义"))
            remaining = requested - set(result["fields"])
            record["fields"] = fields
            record["remaining_unresolved"] = sorted(remaining)

            truth_fields = truth.get("fields") or {}
            _add_contribution(contribution["deterministic"],
                              {key: fields[key] for key in deterministic},
                              truth_fields, tolerances)
            _add_contribution(contribution["template"], template_fields,
                              truth_fields, tolerances)
            _add_contribution(contribution["vlm"],
                              {key: fields[key] for key in record.get("vlm_fields", [])},
                              truth_fields, tolerances)
            relevant = {key for key in truth_fields if key in scorable}
            correct_reject = truth.get("allow_auto_import") is False and not fields
            if not correct_reject:
                mapped += len(relevant.intersection(fields))
                expected += len(relevant)
                for key in relevant:
                    if isinstance(truth_fields[key], list):
                        arrays_total += 1
                        same_length = (isinstance(fields.get(key), list)
                                       and len(fields[key]) == len(truth_fields[key]))
                        lengths_ok += same_length
                        orders_ok += same_length and _field_matches(
                            key, fields[key], truth_fields, tolerances)
            status = _hybrid_status(fields, remaining, bool(record.get("vlm_fields")))
            if fields and template_fields and template_result.get("status") != "ok":
                status = "review"
            extracted = {"fields": fields, "status": status,
                         "controller_family": template_result.get("controller_family"),
                         "page_type": template_result.get("page_type")}
            truth_for_verify = {**truth, "image": (truth.get("image") or {}).get("file", case_id)}
            per_image.append(compare_one(truth_for_verify, extracted, scorable, tolerances))
            results.append(record)
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            stream.flush()
            print(f"[{index}/{len(selected)}] {case_id}: "
                  f"{'error' if 'error' in record else f'{len(fields)} fields'}", flush=True)

    verify = build_report(per_image, [], mode="contract",
                          catalog_version=catalog.get("contract_version"))
    summary = {
        "model": "Qwen3.8-27B-AWQ-INT4",
        "base_url": "http://localhost:8003/v1",
        "cases": len(selected),
        "dataset_contract_version": manifest.get("contract_version"),
        "catalog_contract_version": catalog.get("contract_version"),
        "lifecycle_eligible": False,
        "lifecycle_note": "dataset 2.8.0 与 catalog 2.11.0 既有漂移，禁止晋级",
        "field_mapping_accuracy": round(mapped / expected, 4) if expected else None,
        "structure_accuracy": round(lengths_ok / arrays_total, 4) if arrays_total else None,
        "array_length_accuracy": round(lengths_ok / arrays_total, 4) if arrays_total else None,
        "array_order_accuracy": round(orders_ok / arrays_total, 4) if arrays_total else None,
        "illegal_reference_rate": round(illegal_references / len(selected), 4),
        "parse_failure_rate": round(parse_failures / len(selected), 4),
        "non_ocr_source_values": 0,
        "contribution": {**contribution, "vlm_calls": vlm_calls,
                         "vlm_call_rate": round(vlm_calls / len(selected), 4)},
        "latency_s": {
            source: {"p50": _text_eval_percentile(values, 0.5),
                     "p95": _text_eval_percentile(values, 0.95),
                     "max": round(max(values), 3) if values else None}
            for source, values in (("deterministic", deterministic_latencies),
                                   ("template", template_latencies),
                                   ("vlm", vlm_latencies))
        },
        "usage": {key: sum(item.get(key, 0) or 0 for item in usages)
                  for key in ("prompt_tokens", "completion_tokens", "total_tokens")},
        "verify_accuracy": verify,
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def text_eval_main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=ROOT / "artifacts/068_s0_baseline.json")
    parser.add_argument("--catalog", type=Path, default=ROOT / "contracts/field_catalog.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cases", nargs="*")
    args = parser.parse_args()
    try:
        run_text_evaluation(args.baseline, args.output, args.catalog, args.cases)
    except VlmError as exc:
        print(f"[vlm-text-eval] CONTROLLED_STOP: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(text_eval_main())
