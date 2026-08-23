"""离线评测 OCR token → catalog 字段映射；不读取原图、不接生产入口。"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from extract_generic import extract_generic  # noqa: E402
from verify_accuracy import build_report, compare_one  # noqa: E402
from vlm_qwen import (VlmError, check_text_model, load_catalog,  # noqa: E402
                      map_text_evidence)


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
        if case_id in result:
            raise VlmError(f"固定清单 OCR sidecar 重复：{case_id}")
        result[case_id] = path
    return result


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
    per_image, latencies, usages, results = [], [], [], []
    parse_failures = illegal_references = mapped = expected = 0
    structures_ok = structures_total = 0
    with (output_dir / "results.jsonl").open("w", encoding="utf-8") as stream:
        for index, case_id in enumerate(selected, 1):
            truth_path = truth_paths.get(case_id)
            ocr_path = sidecars.get(case_id)
            if truth_path is None or ocr_path is None:
                raise VlmError(f"固定清单输入缺失：{case_id}")
            rectify_path = ocr_path.with_name(f"{case_id}.rectify.json")
            truth = yaml.safe_load(truth_path.read_text(encoding="utf-8"))
            ocr = json.loads(ocr_path.read_text(encoding="utf-8"))
            rectify = json.loads(rectify_path.read_text(encoding="utf-8"))
            evidence = extract_generic(
                ocr, rectify["screen_size"], truth["page_type"])["detail"]["evidence"]
            record = {"case_id": case_id, "page_type": truth["page_type"]}
            try:
                result = map_text_evidence(evidence, catalog)
                fields = result["fields"]
                record.update({"fields": fields, "mappings": result["mappings"],
                               "latency_s": result["latency_s"], "usage": result["usage"]})
                latencies.append(result["latency_s"])
                if isinstance(result.get("usage"), dict):
                    usages.append(result["usage"])
            except VlmError as exc:
                fields = {}
                record["error"] = str(exc)
                parse_failures += "JSON" in str(exc) or "响应结构" in str(exc)
                illegal_references += any(word in str(exc) for word in
                                          ("未知", "重复", "越界", "直接数值", "引用结构", "歧义"))

            truth_fields = truth.get("fields") or {}
            relevant = {key for key in truth_fields if key in scorable}
            mapped += len(relevant.intersection(fields))
            expected += len(relevant)
            for key in relevant:
                if isinstance(truth_fields[key], list):
                    structures_total += 1
                    structures_ok += isinstance(fields.get(key), list) and len(fields[key]) == len(truth_fields[key])
            extracted = {"fields": fields, "status": "ok" if fields else "reject",
                         "controller_family": truth.get("controller_family"),
                         "page_type": truth["page_type"]}
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
        "structure_accuracy": round(structures_ok / structures_total, 4) if structures_total else None,
        "illegal_reference_rate": round(illegal_references / len(selected), 4),
        "parse_failure_rate": round(parse_failures / len(selected), 4),
        "non_ocr_source_values": 0,
        "latency_s": {"p50": _text_eval_percentile(latencies, 0.5),
                      "p95": _text_eval_percentile(latencies, 0.95),
                      "max": round(max(latencies), 3) if latencies else None},
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
        check_text_model()
        run_text_evaluation(args.baseline, args.output, args.catalog, args.cases)
    except VlmError as exc:
        print(f"[vlm-text-eval] CONTROLLED_STOP: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(text_eval_main())
