"""主入口流水线：去重 → 质量门禁 → OCR → UI/页面分类 → 报告

按 docs/002 定义的顺序：
  图片
  -> SHA-256 去重
  -> 屏幕检测与质量评分
  -> 合格: 透视矫正 → UI 家族识别 → 页面识别 → OCR → 字段校验
  -> 输出三色 triage + 重拍指引

用法：
    python scripts/run_pipeline.py <images_dir> --output <report.json>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 让脚本可以 import dedup / quality / ocr_one / classify_ui
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from dedup import scan, build_groups
from quality import assess


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images_dir")
    ap.add_argument("--output", "-o", required=True, help="合并报告 JSON")
    ap.add_argument("--workdir", default="output", help="中间产物目录")
    ap.add_argument("--ocr-skip", action="store_true", help="跳过 OCR 步骤（去重+质量门禁）")
    args = ap.parse_args()

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "json").mkdir(exist_ok=True)

    # Step 1: SHA-256 去重
    print("[step 1] SHA-256 dedup")
    rows = scan(Path(args.images_dir))
    groups = build_groups(rows)
    dedup_report = {
        "total_files": len(rows),
        "duplicate_groups_within_record": len(groups["duplicate_within_record"]),
        "duplicate_groups_across_records": len(groups["duplicate_across_records"]),
        "duplicate_within_record": groups["duplicate_within_record"],
        "duplicate_across_records": groups["duplicate_across_records"],
        "unique": [r["filename"] for r in groups["unique"]],
    }
    dedup_path = workdir / "dedup_report.json"
    dedup_path.write_text(json.dumps(dedup_report, ensure_ascii=False, indent=2))
    print(f"  -> {dedup_path}")

    # Step 2: 质量门禁
    print("[step 2] quality gate")
    image_paths = [Path(r["path"]) for r in rows]
    quality_reports = []
    triage_counts = {"green": 0, "yellow": 0, "red": 0}
    for p in image_paths:
        r = assess(p)
        quality_reports.append(r)
        triage_counts[r.triage] += 1
    quality_path = workdir / "quality_report.json"
    from dataclasses import asdict
    quality_path.write_text(json.dumps({
        "summary": triage_counts,
        "reports": [asdict(r) for r in quality_reports],
    }, ensure_ascii=False, indent=2))
    print(f"  -> {quality_path} (green={triage_counts['green']} yellow={triage_counts['yellow']} red={triage_counts['red']})")

    # Step 3: OCR（仅绿灯和需要黄灯复检的）
    if not args.ocr_skip:
        print("[step 3] OCR (PP-OCRv4 ch)")
        # 这里只对绿灯/黄灯跑 OCR
        from ocr_one import main as ocr_main
        import subprocess
        ocr_outputs = []
        for r in quality_reports:
            if r.triage == "red":
                continue
            ocr_json = workdir / "json" / f"{Path(r.filename).stem}.ocr.json"
            cmd = [
                "python3", str(HERE / "ocr_one.py"),
                str(Path(args.images_dir) / r.filename),
                "--output", str(ocr_json),
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0:
                ocr_outputs.append(ocr_json)
                print(f"  ok  {r.filename}")
            else:
                print(f"  FAIL {r.filename}: {res.stderr[:200]}")
        print(f"  -> {len(ocr_outputs)} ocr files in {workdir / 'json'}")

        # Step 4: UI 家族 / 页面分类
        if ocr_outputs:
            print("[step 4] classify UI family / page")
            from classify_ui import classify
            classify_results = []
            for oj in ocr_outputs:
                classify_results.append(classify(oj))
            classify_path = workdir / "classify_report.json"
            classify_path.write_text(json.dumps(classify_results, ensure_ascii=False, indent=2))
            print(f"  -> {classify_path}")
            for cr in classify_results:
                print(f"  {cr['filename']}: {cr['ui_family']}({cr['ui_family_confidence']}) / {cr['page']}({cr['page_confidence']})")

    # 合并报告
    print("[done] consolidated report")
    final = {
        "dedup": dedup_report,
        "quality": {
            "summary": triage_counts,
            "reports": [asdict(r) for r in quality_reports],
        },
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(final, ensure_ascii=False, indent=2))
    print(f"  -> {args.output}")


if __name__ == "__main__":
    main()