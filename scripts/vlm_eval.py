"""VLM 真值回放评测：对既有 ground_truth 跑 Qwen3-VL 字段抽取并出字段级报告。

用法：
    python scripts/vlm_eval.py \
        --truth-dir ground_truth/inj_z031_injection \
        --image-dirs docs/samples_inj_z031 \
        [--catalog contracts/field_catalog.json] \
        --output output/vlm_eval/<run_name>/

产出：
- results.jsonl：每图一行，含 VLM 输出、逐字段比对结果、延迟与用量
- summary.json：逐字段准确率、失败模式计数、延迟分布

比对规则：
- 只评测 catalog 中 source_pages 含该 page_type 的字段（与 VLM 提示词同一子集）；
- 标量与数组元素按 catalog tolerance 判定；容差缺失时默认 0.5% 相对容差；
- 数组长度不一致记 structure_error；VLM 输出 null 记 vlm_null；
  真值为 null 的字段跳过（无可比基准）。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vlm_qwen  # noqa: E402


def find_image(filename: str, image_dirs: list[Path]) -> Path | None:
    for d in image_dirs:
        candidate = d / filename
        if candidate.exists():
            return candidate
    return None


def _close(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= max(tol, abs(b) * 0.005)


def _to_float(value) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def compare_field(key: str, vlm_value, truth_value, meta: dict) -> str:
    """返回 per-field 判定：ok / wrong_value / vlm_null / structure_error / skipped_non_numeric。"""
    if vlm_value is None:
        return "vlm_null"
    tol = float(meta.get("tolerance") or 0.0)
    expect_list = (meta.get("value_type") or "").startswith("list")
    if expect_list:
        truth_list = truth_value if isinstance(truth_value, list) else [truth_value]
        truth_nums = [x for x in (_to_float(v) for v in truth_list) if x is not None]
        if not truth_nums:
            return "skipped_non_numeric"
        if vlm_value is None:
            return "vlm_null"
        if not isinstance(vlm_value, list) or len(vlm_value) != len(truth_nums):
            return "structure_error"
        for v, t in zip(vlm_value, truth_nums):
            if not _close(float(v), t, tol):
                return "wrong_value"
        return "ok"
    if isinstance(truth_value, list):
        truth_nums = [x for x in (_to_float(v) for v in truth_value) if x is not None]
        if len(truth_nums) != 1:
            return "skipped_non_numeric"
        target = truth_nums[0]
    else:
        num = _to_float(truth_value)
        if num is None:
            return "skipped_non_numeric"  # 枚举/文本型真值（如 holding_switch_mode=位置）
        target = num
    if vlm_value is None:
        return "vlm_null"
    return "ok" if _close(float(vlm_value), target, tol) else "wrong_value"


def main() -> int:
    parser = argparse.ArgumentParser(description="Qwen3-VL 对 ground_truth 的字段级回放评测")
    parser.add_argument("--truth-dir", required=True, type=Path)
    parser.add_argument("--image-dirs", required=True, nargs="+", type=Path,
                        help="按真值 image 文件名搜索图片的目录（可多个）")
    parser.add_argument("--catalog", type=Path,
                        default=Path(__file__).resolve().parent.parent / "contracts" / "field_catalog.json")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--reverse-stages", action="store_true",
                        help="比对前将 VLM 数组字段整体反转（用于屏幕列序与物理段序相反的页面，"
                             "验证失败是否纯段序问题；段数标量不受影响）")
    args = parser.parse_args()

    catalog = vlm_qwen.load_catalog(args.catalog)
    args.output.mkdir(parents=True, exist_ok=True)

    truth_files = sorted(args.truth_dir.glob("*.truth.json"))
    if not truth_files:
        print(f"未找到真值文件：{args.truth_dir}", file=sys.stderr)
        return 1

    field_stats: dict[str, dict[str, int]] = {}
    latencies: list[float] = []
    n_images = 0
    n_errors = 0

    results_path = args.output / "results.jsonl"
    with results_path.open("w", encoding="utf-8") as out:
        for truth_path in truth_files:
            truth = json.loads(truth_path.read_text(encoding="utf-8"))
            image_name = truth.get("image")
            page_type = truth.get("page_type")
            record = {"truth": truth_path.name, "image": image_name,
                      "page_type": page_type, "comparisons": {}}
            image_path = find_image(image_name, args.image_dirs) if image_name else None
            if image_path is None:
                record["error"] = f"image_not_found:{image_name}"
                n_errors += 1
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                continue
            try:
                result = vlm_qwen.extract_fields(
                    image_path, page_type, catalog,
                    reverse_stage_arrays=args.reverse_stages)
            except vlm_qwen.VlmError as exc:
                record["error"] = str(exc)
                n_errors += 1
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                continue

            n_images += 1
            latencies.append(result["latency_s"])
            record["latency_s"] = result["latency_s"]
            record["usage"] = result.get("usage")
            record["validation_errors"] = result["validation_errors"]
            record["parse_notes"] = result["parse_notes"]

            page_fields = vlm_qwen.fields_for_page(catalog, page_type)
            truth_fields = truth.get("fields") or {}
            vlm_fields = result["fields"]
            for key, meta in page_fields.items():
                truth_value = truth_fields.get(key)
                if truth_value is None:
                    continue  # 真值缺失，无可比基准
                verdict = compare_field(key, vlm_fields.get(key), truth_value, meta)
                record["comparisons"][key] = {
                    "verdict": verdict,
                    "vlm": vlm_fields.get(key),
                    "truth": truth_value,
                }
                stats = field_stats.setdefault(key, {})
                stats[verdict] = stats.get(verdict, 0) + 1
            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            print(f"[{n_images + n_errors}/{len(truth_files)}] {truth_path.name} "
                  f"({result['latency_s']}s)")

    per_field = {}
    for key, stats in sorted(field_stats.items()):
        total = sum(stats.values()) - stats.get("skipped_non_numeric", 0)
        ok = stats.get("ok", 0)
        per_field[key] = {"accuracy": round(ok / total, 4) if total else None,
                          "total": total, **stats}
    latencies_sorted = sorted(latencies)
    summary = {
        "run_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "truth_dir": str(args.truth_dir),
        "model": vlm_qwen.MODEL,
        "base_url": vlm_qwen.BASE_URL,
        "images_evaluated": n_images,
        "images_errored": n_errors,
        "latency_s": {
            "min": round(latencies_sorted[0], 2) if latencies_sorted else None,
            "median": round(latencies_sorted[len(latencies_sorted) // 2], 2) if latencies_sorted else None,
            "max": round(latencies_sorted[-1], 2) if latencies_sorted else None,
        },
        "per_field": per_field,
    }
    (args.output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n完成：{n_images} 图成功，{n_errors} 图失败 → {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
