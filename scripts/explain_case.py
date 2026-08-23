"""把单张 HMI 的模板提取过程和真值差异打印成人能读的报告。"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_fields import MACHINE_LABELS, RECORD_REPORT, TEMPLATES_DIR, extract_one  # noqa: E402
from verify_accuracy import compare_elements, flatten_scorable  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "contracts/field_catalog.json"

WARNING_HELP = {
    "DROP_PORT_CURRENT_MISSING": "下料口有设定温度，但当前温度没有读到；禁止自动导入。",
    "CHANNELS_INSUFFICIENT": "识别出的热流道有效通道不超过总通道的一半；禁止自动导入。",
}


def _load(path: Path) -> dict | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def _warning_help(warning: str) -> str:
    key = warning.split("(", 1)[0]
    return WARNING_HELP.get(key, "提取器报告了不确定性；有字段时状态降为 review。")


def _truth_report(result: dict, truth_path: Path) -> None:
    truth = yaml.safe_load(truth_path.read_text(encoding="utf-8"))
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))["fields"]
    truth_fields = truth.get("fields") or {}
    scorable = {name: "text" if catalog.get(name, {}).get("value_type") in ("str", "string")
                else "numeric" for name in truth_fields}
    tolerances = {name: catalog.get(name, {}).get("tolerance", 0.5)
                  for name in truth_fields}
    elements = compare_elements(flatten_scorable(truth_fields, scorable),
                                flatten_scorable(result.get("fields"), scorable),
                                scorable, tolerances)
    print("\n[逐字段真值对比]")
    for item in elements:
        mark = "PASS" if item["matched"] else "FAIL"
        print(f"{mark:4} {item['field']}: 识别={item['extracted']!r} 真值={item['truth']!r}")
    matched = sum(item["matched"] for item in elements)
    print(f"合计: {matched}/{len(elements)} 个真值元素匹配")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stem", help="图片 stem，例如 barrel_A11_9835fbea")
    parser.add_argument("--rectified-dir", type=Path, required=True,
                        help="包含 <stem>.ocr.json 和 <stem>.rectify.json 的目录")
    parser.add_argument("--truth", type=Path, help="可选的 datasets/.../<stem>.truth.yml")
    parser.add_argument("--no-priors", action="store_true",
                        help="不读取 record_report 和 machine_labels，单测图片内容路由")
    args = parser.parse_args()

    record_report = None if args.no_priors else _load(ROOT / RECORD_REPORT)
    machine_labels = None if args.no_priors else _load(ROOT / MACHINE_LABELS)
    result = extract_one(args.stem, args.rectified_dir, record_report, machine_labels,
                         ROOT / TEMPLATES_DIR)
    provenance = result.get("provenance") or {}
    sidecars = sorted(p.name for p in args.rectified_dir.glob(f"{args.stem}.ocr_*.json"))

    print("[实际字段提取链（从已有 OCR 开始）]")
    print(f"输入: {provenance.get('ocr_file', '缺少 OCR/矫正产物')}")
    print(f"OCR 旁车: {', '.join(sidecars) if sidecars else '无'}")
    print(f"控制器: {result.get('controller_family')}（来源: {provenance.get('family_source')}）")
    print(f"页面: {result.get('page_type')}（来源: {provenance.get('page_source')}）")
    print(f"算法: {provenance.get('template', '未进入提取器')}；当前生产字段提取仍是模板/专用提取器")
    print(f"状态: {str(result.get('status')).upper()}；自动导入: "
          f"{'是' if result.get('status') == 'ok' else '否'}")

    print("\n[拦截原因]")
    if result.get("warnings"):
        for warning in result["warnings"]:
            print(f"- {warning}: {_warning_help(warning)}")
    else:
        print("无 warning：有字段时状态为 ok。")

    print("\n[识别字段]")
    print(json.dumps(result.get("fields"), ensure_ascii=False, indent=2))
    print("\n[提取证据]")
    print(json.dumps(result.get("extraction_detail"), ensure_ascii=False, indent=2))

    if args.truth:
        _truth_report(result, args.truth)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
