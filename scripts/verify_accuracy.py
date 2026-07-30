"""S4 真值比对：提取结果 vs S3 字段级真值，报告 6 项验收指标。

指标（公式与 PLAN §3 统一）：
1. controller_classification_accuracy — |family 一致的图| / |全部图|（大小写归一）
2. page_classification_accuracy       — |page_type 一致的图| / |全部图|
3. field_completeness                 — |提取非空的数值字段元素| / |真值非空数值字段元素|
4. numeric_accuracy                   — |匹配真值(允许误差 ±0.5)的数值字段元素| / |真值非空数值字段元素|，门槛 >= 95%
5. auto_import_ratio                  — |status=ok 的图| / |全部图|
6. error_auto_import_rate             — |误识别但仍 status=ok 的字段元素| / |status=ok 图的字段元素|，门槛严格 = 0

数值字段元素 = 标量字段本身或数组字段的单个元素；数组长度不一致时，真值侧超出的
元素计为"提取缺失"（不完整 + 不匹配）。

用法：
    python scripts/verify_accuracy.py output/extracted --truth ground_truth/zizes_temperature \
        --output output/accuracy_report.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TOLERANCE = 0.5
GATE_NUMERIC_ACCURACY = 0.95
GATE_ERROR_AUTO_IMPORT_RATE = 0.0

# 真值 schema 的数值字段（oil_temperature_current_c 为 2026-07-30 新增，以真值集为准）
NUMERIC_FIELDS = [
    "barrel_temperature_set_c",
    "barrel_temperature_current_c",
    "oil_temperature_set_c",
    "oil_temperature_current_c",
    "control_percent",
]


def flatten_numeric(fields: dict | None) -> dict[str, float | None]:
    """{field: scalar|[...]} -> {field 或 field[i]: value}；缺失/None 记为 None。"""
    flat: dict[str, float | None] = {}
    if not fields:
        return flat
    for name in NUMERIC_FIELDS:
        v = fields.get(name)
        if isinstance(v, list):
            for i, item in enumerate(v):
                flat[f"{name}[{i}]"] = item
        else:
            flat[name] = v
    return flat


def compare_one(truth: dict, extracted: dict | None) -> dict:
    """单图比对，返回该图的逐元素明细与计数。"""
    t_family = truth.get("controller_family", "")
    t_page = truth.get("page_type", "")
    e_family = (extracted or {}).get("controller_family", "")
    e_page = (extracted or {}).get("page_type", "")
    status = (extracted or {}).get("status", "reject")

    t_flat = flatten_numeric(truth.get("fields"))
    e_flat = flatten_numeric(extracted.get("fields") if extracted else None)

    elements = []
    for key, t_val in t_flat.items():
        if t_val is None:
            continue  # 真值空缺不计入分母
        e_val = e_flat.get(key)
        matched = e_val is not None and abs(e_val - t_val) <= TOLERANCE
        elements.append({
            "field": key,
            "truth": t_val,
            "extracted": e_val,
            "present": e_val is not None,
            "matched": matched,
        })

    return {
        "image": truth["image"],
        "status": status,
        "family_truth": t_family,
        "family_extracted": e_family,
        "family_match": bool(t_family) and t_family.upper() == str(e_family).upper(),
        "page_truth": t_page,
        "page_extracted": e_page,
        "page_match": bool(t_page) and t_page == e_page,
        "n_elements": len(elements),
        "n_present": sum(1 for e in elements if e["present"]),
        "n_matched": sum(1 for e in elements if e["matched"]),
        "elements": elements,
    }


def main():
    ap = argparse.ArgumentParser(description="S4 提取结果 vs 真值：6 项验收指标")
    ap.add_argument("extracted_dir", help="extract_fields 输出目录（*.fields.json）")
    ap.add_argument("--truth", required=True, help="真值目录（*.truth.json）")
    ap.add_argument("--output", "-o", required=True)
    args = ap.parse_args()

    extracted_dir = Path(args.extracted_dir)
    truth_dir = Path(args.truth)
    truth_files = sorted(truth_dir.glob("*.truth.json"))
    if not truth_files:
        sys.exit(f"[verify] ERROR: 真值目录为空: {truth_dir}")

    per_image = []
    missing_extraction = []
    for tf in truth_files:
        truth = json.loads(tf.read_text())
        stem = Path(truth["image"]).stem
        ef = extracted_dir / f"{stem}.fields.json"
        extracted = json.loads(ef.read_text()) if ef.is_file() else None
        if extracted is None:
            missing_extraction.append(truth["image"])
        per_image.append(compare_one(truth, extracted))

    n = len(per_image)
    total_elements = sum(p["n_elements"] for p in per_image)
    total_present = sum(p["n_present"] for p in per_image)
    total_matched = sum(p["n_matched"] for p in per_image)
    ok_images = [p for p in per_image if p["status"] == "ok"]
    ok_elements = sum(p["n_elements"] for p in ok_images)
    ok_errors = sum(p["n_elements"] - p["n_matched"] for p in ok_images)

    metrics = {
        "controller_classification_accuracy": round(sum(p["family_match"] for p in per_image) / n, 4),
        "page_classification_accuracy": round(sum(p["page_match"] for p in per_image) / n, 4),
        "field_completeness": round(total_present / total_elements, 4) if total_elements else None,
        "numeric_accuracy": round(total_matched / total_elements, 4) if total_elements else None,
        "auto_import_ratio": round(len(ok_images) / n, 4),
        "error_auto_import_rate": round(ok_errors / ok_elements, 4) if ok_elements else None,
    }
    gates = {
        "numeric_accuracy >= 0.95": (metrics["numeric_accuracy"] or 0) >= GATE_NUMERIC_ACCURACY,
        "error_auto_import_rate == 0": (metrics["error_auto_import_rate"] or 0) == GATE_ERROR_AUTO_IMPORT_RATE,
    }
    report = {
        "version": "1.0",
        "plan_ref": "docs/007_PLAN_20260730_端到端薄切片实施计划.md §3",
        "tolerance": TOLERANCE,
        "n_images": n,
        "metrics": metrics,
        "gates": gates,
        "poc_pass": all(gates.values()),
        "gate_semantics": "PoC 可跑通判定：达标 = 允许进入扩样验证，不代表许可生产环境真实自动入库",
        "missing_extraction": missing_extraction,
        "per_image": [
            {k: v for k, v in p.items() if k != "elements"} for p in per_image
        ],
        "mismatched_elements": [
            {"image": p["image"], **e}
            for p in per_image for e in p["elements"] if not e["matched"]
        ],
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    print(f"[verify] {n} 张真值图，提取缺失 {len(missing_extraction)} 张")
    for k, v in metrics.items():
        print(f"  {k}: {v}")
    for k, v in gates.items():
        print(f"  gate {k}: {'PASS' if v else 'FAIL'}")
    print(f"[verify] report -> {out_path}")


if __name__ == "__main__":
    main()
