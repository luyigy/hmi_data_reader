"""S4 真值比对：提取结果 vs S3 字段级真值，报告 6 项验收指标。

指标（公式与 PLAN §3 统一）：
1. controller_classification_accuracy — |family 一致的图| / |全部图|（大小写归一）
2. page_classification_accuracy       — |page_type 一致的图| / |全部图|
3. field_completeness                 — |提取非空的数值字段元素| / |计分真值非空数值字段元素|
4. numeric_accuracy                   — |匹配真值(允许误差 ±0.5)的数值字段元素| / |计分真值非空数值字段元素|，门槛 >= 95%
5. auto_import_ratio                  — |status=ok 的图| / |全部图|
6. error_auto_import_rate             — |误识别但仍 status=ok 的字段元素| / |status=ok 图的字段元素|，门槛严格 = 0
7. rejection_accuracy                 — |正确拒识(status!=ok)的 allow_auto_import=false 图| / |allow_auto_import=false 图|，门槛严格 = 1，空分母 N/A

计分口径（023 PLAN §3）：仅真值 allow_auto_import=false 且提取 status != ok 的
正确拒识图片，其数值元素从 3/4 两项的分母、分子中排除；错误放行（status=ok）
的负样本不排除。报告 scoring 块保留全量/计分计数与排除图片及原因。

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

# 真值 schema 的数值字段（oil_temperature_current_c 为 2026-07-30 新增，
# holding/drop_port_* 为 2026-07-31 TACT 新增；high/low_deviation_c 为
# 2026-07-31 伯乐 KEBA/B_AND_R 新增；以真值集为准，家族间取并集，
# 不属于该家族真值的字段读出来是 None，不会进入分母）
NUMERIC_FIELDS = [
    "barrel_temperature_set_c",
    "barrel_temperature_current_c",
    "oil_temperature_set_c",
    "oil_temperature_current_c",
    "control_percent",
    "holding_temperature_c",
    "drop_port_temperature_set_c",
    "drop_port_temperature_current_c",
    "drop_port_control_percent",
    "high_deviation_c",
    "low_deviation_c",
    # 035 射出/保压页（TACT injection_metering）新增；以真值集为准取并集
    "fill_velocity_mms",
    "fill_stages",
    "switch_position_sv1_mm",
    "switch_position_sv2_mm",
    "metering_position_sm_mm",
    "metering_rpm",
    "back_pressure_mpa",
    "holding_pressure_mpa",
    "holding_stages",
    "holding_time_s",
    "holding_limit_speed_mms",
    "vp_switch_position_mm",
    "pressure_limit_mpa",
    "injection_time_s",
    "cooling_time_s",
    "decompress_velocity_mms",
    "sd_position_mm",
    # 035 第三波 FANUC 射出/计量页（Z036）新增；以真值集为准取并集
    "injection_velocity_mms",
    "injection_pressure_limit_mpa",
    "injection_switch_position_mm",
    "max_injection_time_s",
    "injection_alarm_pressure_mpa",
    "metering_back_pressure_mpa",
    "metering_rpm_stages",
    "metering_switch_positions_mm",
    "decompress_mms",
    # 049 A1 ZIZES 射出页（Z017）新增；以真值集为准取并集
    "injection_pressure_bar",
    "injection_velocity_pct",
    "injection_position_mm",
    "injection_stages",
    "injection_time_s",
    "injection_delay_s",
    "holding_pressure_bar",
    "holding_velocity_pct",
    "holding_switch_mode",
    "pressure_upper_limit_bar",
    "pressure_lower_limit_bar",
    # 049 A2 KEBA 射出页（Z031）新增
    "injection_end_position_mm",
    # 049 A3 B_AND_R 射胶页（Z050）新增
    "vp_switch_time_s",
    # 049 A6 TRD6 注射设定页（Z020）新增
    "injection_positions_mm",
    "metering_position_mm",
    "injection_time_limit_s",
    "holding_velocity_mms",
    "dwell_time_s",
    "metering_delay_s",
    "suckback_mm",
    "suckback_speed_pct",
    "purge_velocity_mms",
    "purge_count",
    # 049 B1 储料/冷却（Z036）新增
    "decompress_position_mm",
    # 035 第二波 DEMAG 射出/保压页新增；以真值集为准取并集
    "pressure_limit_bar",
    "first_velocity_mms",
    "first_position_mm",
    "stage_velocity_mms",
    "stage_pressure_bar",
    "plasticizing_speed_rpm",
    "back_pressure_bar",
    "holding_pressure_bar",
    "holding_velocity_mms",
    "cushion_mm",
    "switch_position_mm",
    "switch_pressure_bar",
    "switch_time_s",
    "injection_velocity_mms",
    "injection_pressure_limit_bar",
]


def truth_numeric_keys(fields: dict | None) -> list[str]:
    """真值 fields 里所有数值型（标量或数值数组）键——用于漏算检查。"""
    keys = []
    for k, v in (fields or {}).items():
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            keys.append(k)
        elif isinstance(v, list) and v and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v):
            keys.append(k)
    return keys


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
        if isinstance(t_val, str) or isinstance(e_val, str):
            # 文本型字段（如 KEBA 转保压方式 时间/位置）：等值比对
            matched = e_val is not None and e_val == t_val
        else:
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
        "allow_auto_import": truth.get("allow_auto_import"),
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
    uncovered = {}  # 真值数值字段未被 NUMERIC_FIELDS 覆盖 -> 防漏算硬检查
    for tf in truth_files:
        truth = json.loads(tf.read_text())
        miss = [k for k in truth_numeric_keys(truth.get("fields")) if k not in NUMERIC_FIELDS]
        if miss:
            uncovered[truth["image"]] = miss
        stem = Path(truth["image"]).stem
        ef = extracted_dir / f"{stem}.fields.json"
        extracted = json.loads(ef.read_text()) if ef.is_file() else None
        if extracted is None:
            missing_extraction.append(truth["image"])
        per_image.append(compare_one(truth, extracted))

    if uncovered:
        # 真值含 NUMERIC_FIELDS 之外的数值字段：继续跑会把它漏出分母形成假高分，直接失败
        sys.exit(f"[verify] ERROR: 真值数值字段未被 NUMERIC_FIELDS 覆盖（会漏算出假高分）: "
                 f"{json.dumps(uncovered, ensure_ascii=False)}")

    n = len(per_image)

    # 023 PLAN §3 拒识口径：只有真值 allow_auto_import=false 且提取 status != ok 的
    # 正确拒识图片，其数值元素才从 field_completeness / numeric_accuracy 计分排除；
    # 错误放行（status=ok）的负样本不排除。controller/page/auto_import_ratio 仍在
    # 全量上如实报告；rejection_accuracy 为独立安全指标，空分母记 N/A（不宣称 PASS）
    for p in per_image:
        p["correct_reject"] = p["allow_auto_import"] is False and p["status"] != "ok"
    scored = [p for p in per_image if not p["correct_reject"]]
    excluded = [p for p in per_image if p["correct_reject"]]
    neg = [p for p in per_image if p["allow_auto_import"] is False]

    def totals(rows: list[dict]) -> dict:
        return {
            "n_images": len(rows),
            "n_elements": sum(p["n_elements"] for p in rows),
            "n_present": sum(p["n_present"] for p in rows),
            "n_matched": sum(p["n_matched"] for p in rows),
        }

    raw_totals = totals(per_image)
    scored_totals = totals(scored)
    ok_images = [p for p in per_image if p["status"] == "ok"]
    ok_elements = sum(p["n_elements"] for p in ok_images)
    ok_errors = sum(p["n_elements"] - p["n_matched"] for p in ok_images)

    metrics = {
        "controller_classification_accuracy": round(sum(p["family_match"] for p in per_image) / n, 4),
        "page_classification_accuracy": round(sum(p["page_match"] for p in per_image) / n, 4),
        "field_completeness": round(scored_totals["n_present"] / scored_totals["n_elements"], 4)
            if scored_totals["n_elements"] else None,
        "numeric_accuracy": round(scored_totals["n_matched"] / scored_totals["n_elements"], 4)
            if scored_totals["n_elements"] else None,
        "auto_import_ratio": round(len(ok_images) / n, 4),
        "error_auto_import_rate": round(ok_errors / ok_elements, 4) if ok_elements else None,
        "rejection_accuracy": round(sum(p["status"] != "ok" for p in neg) / len(neg), 4) if neg else None,
    }
    gates = {
        "numeric_accuracy >= 0.95": (metrics["numeric_accuracy"] is not None
                                     and metrics["numeric_accuracy"] >= GATE_NUMERIC_ACCURACY),
        "error_auto_import_rate == 0": (metrics["error_auto_import_rate"] is not None
                                        and metrics["error_auto_import_rate"] == GATE_ERROR_AUTO_IMPORT_RATE),
        "rejection_accuracy == 1": ("N/A" if metrics["rejection_accuracy"] is None
                                    else metrics["rejection_accuracy"] == 1.0),
    }
    report = {
        "version": "1.1",
        "plan_ref": "docs/007_PLAN_20260730_端到端薄切片实施计划.md §3；拒识口径 docs/023_PLAN_20260801_伯乐S3拒识口径与定向收口.md §3",
        "tolerance": TOLERANCE,
        "n_images": n,
        "metrics": metrics,
        "gates": gates,
        "poc_pass": all(v is True or v == "N/A" for v in gates.values()),
        "gate_semantics": "PoC 可跑通判定：达标 = 允许进入扩样验证，不代表许可生产环境真实自动入库；空分母 numeric/error 门 FAIL，rejection 空分母记 N/A（不宣称 PASS，伯乐批分母应为 1 由验收显式核对）",
        "scoring": {
            "rule": "仅真值 allow_auto_import=false 且提取 status != ok 的正确拒识图，其数值元素从 field_completeness/numeric_accuracy 分母分子排除；错误放行负样本不排除",
            "raw_totals": raw_totals,
            "scored_totals": scored_totals,
            "excluded_images": [
                {"image": p["image"], "n_elements": p["n_elements"],
                 "reason": f"correct_reject(allow_auto_import=false, status={p['status']})"}
                for p in excluded
            ],
        },
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

    print(f"[verify] {n} 张真值图，提取缺失 {len(missing_extraction)} 张，计分排除 {len(excluded)} 张")
    for k, v in metrics.items():
        print(f"  {k}: {v}")
    for k, v in gates.items():
        mark = "N/A" if v == "N/A" else ("PASS" if v else "FAIL")
        print(f"  gate {k}: {mark}")
    print(f"[verify] report -> {out_path}")


if __name__ == "__main__":
    main()
