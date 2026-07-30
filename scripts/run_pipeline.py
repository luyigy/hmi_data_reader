"""主入口流水线：去重 → 质量门禁 → 透视矫正 → OCR → UI/页面分类 →（可选）字段提取 →（可选）真值比对

按 docs/002 定义的顺序，S4（2026-07-30）扩展：
  图片
  -> SHA-256 去重（重复附件不重复 OCR：每组只处理排序第一个代表文件）
  -> 屏幕检测与质量评分
  -> 合格: 透视矫正（rectify.py，失败降级 MANUAL_SCREEN_CONFIRM + 用原图继续）
  -> OCR（矫正图优先）-> 后处理 -> UI 家族识别 -> 页面识别
  -> [--extract] 字段提取（extract_fields.py，OCR + 归一化模板）
  -> [--verify <真值目录>] 真值比对（verify_accuracy.py，6 项指标）

批量产物（output/rectified/、output/extracted/）不进 Git；Git 只保留夹具、真值、汇总报告。

用法：
    python scripts/run_pipeline.py <images_dir> --output <report.json>
    python scripts/run_pipeline.py docs/samples_v3 --output output/pipeline_report.json \
        --extract --verify ground_truth/zizes_temperature --verify-output output/accuracy_report.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

# 让脚本可以 import dedup / quality / rectify / postprocess / extract_fields
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from dedup import scan, build_groups
from quality import assess
from rectify import rectify
from postprocess import postprocess_one


def select_duplicates(groups: dict) -> dict[str, str]:
    """重复组处置：每组只保留排序第一个代表文件，返回 {被跳过的文件名: 代表文件名}。"""
    skipped: dict[str, str] = {}
    for grp in groups["duplicate_within_record"] + groups["duplicate_across_records"]:
        files = sorted(grp["files"])
        for f in files[1:]:
            skipped[f] = files[0]
    return skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images_dir")
    ap.add_argument("--output", "-o", required=True, help="合并报告 JSON")
    ap.add_argument("--workdir", default="output", help="中间产物目录")
    ap.add_argument("--ocr-skip", action="store_true", help="跳过 OCR 步骤（去重+质量门禁）")
    ap.add_argument("--extract", action="store_true", help="OCR 后跑字段提取（extract_fields）")
    ap.add_argument("--verify", metavar="TRUTH_DIR", help="提取后跑真值比对（verify_accuracy）")
    ap.add_argument("--verify-output", default="output/accuracy_report.json")
    args = ap.parse_args()

    images_dir = Path(args.images_dir)
    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "json").mkdir(exist_ok=True)
    (workdir / "rectified").mkdir(exist_ok=True)

    # Step 1: SHA-256 去重（重复附件不重复 OCR）
    print("[step 1] SHA-256 dedup")
    rows = scan(images_dir)
    groups = build_groups(rows)
    dup_skipped = select_duplicates(groups)
    dedup_report = {
        "total_files": len(rows),
        "duplicate_groups_within_record": len(groups["duplicate_within_record"]),
        "duplicate_groups_across_records": len(groups["duplicate_across_records"]),
        "duplicate_within_record": groups["duplicate_within_record"],
        "duplicate_across_records": groups["duplicate_across_records"],
        "unique": [r["filename"] for r in groups["unique"]],
        "skipped_non_representative": dup_skipped,
    }
    dedup_path = workdir / "dedup_report.json"
    dedup_path.write_text(json.dumps(dedup_report, ensure_ascii=False, indent=2))
    print(f"  -> {dedup_path} (重复组跳过 {len(dup_skipped)} 个非代表文件)")

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
    quality_path.write_text(json.dumps({
        "summary": triage_counts,
        "reports": [asdict(r) for r in quality_reports],
    }, ensure_ascii=False, indent=2))
    print(f"  -> {quality_path} (green={triage_counts['green']} yellow={triage_counts['yellow']} red={triage_counts['red']})")

    # Step 3: 透视矫正（绿灯/黄灯、非重复代表）→ Step 4: OCR（矫正图优先）+ 后处理
    ocr_outputs = []
    extract_stems = []
    if not args.ocr_skip:
        print("[step 3] rectify (corners -> bbox -> manual-confirm fallback)")
        print("[step 4] OCR (PP-OCRv4 ch) + postprocess")
        for r in quality_reports:
            if r.triage == "red":
                continue
            if r.filename in dup_skipped:
                print(f"  skip duplicate {r.filename} (代表: {dup_skipped[r.filename]})")
                continue
            src = images_dir / r.filename
            stem = Path(r.filename).stem
            rect_png = workdir / "rectified" / f"{stem}.png"
            rect_meta = workdir / "rectified" / f"{stem}.rectify.json"
            rr = rectify(src, rect_png, rect_meta)
            if rr["ok"]:
                ocr_target = rect_png
                extract_stems.append(stem)
                if rr.get("method") == "bbox_fallback":
                    print(f"  rectify {r.filename}: bbox 回退分支")
            else:
                # 检测失败：降级人工确认屏幕框，记 warning，用原图继续 OCR
                print(f"  rectify {r.filename}: 失败 {rr.get('reason')} -> MANUAL_SCREEN_CONFIRM，用原图继续")
                ocr_target = src

            ocr_json = (workdir / "rectified" / f"{stem}.ocr.json") if rr["ok"] \
                else (workdir / "json" / f"{stem}.ocr.json")
            cmd = [
                sys.executable, str(HERE / "ocr_one.py"),
                str(ocr_target), "--output", str(ocr_json), "--no-cls",
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0:
                ocr_outputs.append(ocr_json)
                pp = postprocess_one(ocr_json)
                pp_path = Path(str(ocr_json).replace(".ocr.json", ".ocr.postprocessed.json"))
                pp_path.write_text(json.dumps(pp, ensure_ascii=False, indent=2))
                print(f"  ok  {r.filename}")
            else:
                print(f"  FAIL {r.filename}: {res.stderr[:200]}")
        print(f"  -> {len(ocr_outputs)} ocr files")

        # Step 5: UI 家族 / 页面分类
        if ocr_outputs:
            print("[step 5] classify UI family / page")
            from classify_ui import classify
            classify_results = []
            for oj in ocr_outputs:
                classify_results.append(classify(oj))
            classify_path = workdir / "classify_report.json"
            classify_path.write_text(json.dumps(classify_results, ensure_ascii=False, indent=2))
            print(f"  -> {classify_path}")
            for cr in classify_results:
                print(f"  {cr['filename']}: {cr['ui_family']}({cr['ui_family_confidence']}) / {cr['page']}({cr['page_confidence']})")

    # Step 6: 字段提取（OCR + 归一化模板；VLM 不进提取链路）
    if args.extract:
        print("[step 6] extract fields (OCR + normalized template)")
        from extract_fields import extract_one, RECORD_REPORT, MACHINE_LABELS
        record_report = json.loads(RECORD_REPORT.read_text()) if RECORD_REPORT.is_file() else None
        machine_labels = json.loads(MACHINE_LABELS.read_text()) if MACHINE_LABELS.is_file() else None
        extract_dir = workdir / "extracted"
        extract_dir.mkdir(exist_ok=True)
        counts = {"ok": 0, "review": 0, "reject": 0}
        for stem in extract_stems:
            r = extract_one(stem, workdir / "rectified", record_report, machine_labels,
                            Path("templates"))
            counts[r["status"]] += 1
            (extract_dir / f"{stem}.fields.json").write_text(
                json.dumps(r, ensure_ascii=False, indent=2))
            print(f"  {stem}: {r['status']} warnings={r['warnings']}")
        print(f"  -> {extract_dir} (ok={counts['ok']} review={counts['review']} reject={counts['reject']})")

    # Step 7: 真值比对（6 项指标）
    if args.verify:
        print("[step 7] verify accuracy vs truth")
        cmd = [
            sys.executable, str(HERE / "verify_accuracy.py"),
            str(workdir / "extracted"), "--truth", args.verify,
            "--output", args.verify_output,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        print(res.stdout)
        if res.returncode != 0:
            print(f"  verify FAIL: {res.stderr[:300]}")

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
