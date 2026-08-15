"""042 PLAN S03 复现/校准脚手架：忠实复刻 hmi_service.recognize 对 6 张热流道图的处理
（质量 → 矫正 → OCR → 后处理 → 分类 → 条件 sidecar → 字段提取），并按 calibration
真值逐字段比对，输出对照报告。仅本地只读，不调用任何写接口、不联网。

用法：
    .venv/bin/python scripts/s03_hot_runner_repro.py [--keep-rect]
产物：output/s03_hot_runner/repro_report.json（每图 status/fields/warnings/diff/truth）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# 复用脚本目录
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

ROOT = HERE.parent
CALIB = ROOT / "datasets/calibration"
OUT = ROOT / "output/s03_hot_runner"

# case_id -> (profile 目录, 期望正例/负例)
IMAGES = {
    "hr_A06_01c1a438": ("tact.hot_runner_temp.digital_sv", True),
    "hr_A06_458f23df": ("tact.hot_runner_temp.digital_sv", True),
    "hr_A06_4b52c362": ("tact.hot_runner_temp.digital_sv", True),
    "hr_A09_5114279d": ("hot_system.hot_runner_temp.single_zone", False),
    "hr_A09_aca9d8c5": ("hot_system.hot_runner_temp.single_zone", False),
    "hr_A09_f3b3f06d": ("hot_system.hot_runner_temp.single_zone", False),
}


def run_ocr_lines(ocr, png_path: Path) -> list[dict]:
    import cv2  # noqa: F401
    result = ocr.ocr(str(png_path), cls=False)
    lines = []
    if result and result[0]:
        for box, (text, conf) in result[0]:
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            lines.append({
                "text": text,
                "conf": float(conf),
                "bbox": {
                    "points": [[float(p[0]), float(p[1])] for p in box],
                    "x_min": float(min(xs)),
                    "y_min": float(min(ys)),
                    "x_max": float(max(xs)),
                    "y_max": float(max(ys)),
                },
            })
    return lines


def load_truth(case_id: str, profile_dir: str) -> dict:
    import yaml
    d = CALIB / profile_dir
    for yml in d.glob("*.truth.yml"):
        t = yaml.safe_load(yml.read_text())
        if t["case_id"] == case_id:
            return t
    raise FileNotFoundError(f"truth for {case_id} not found in {d}")


def diff_fields(got, truth: dict) -> dict:
    """逐字段比对（None/数值/列表）。返回 {field: {truth, got, ok}}。"""
    out = {}
    keys = sorted(set((got or {}).keys()) | set(truth.keys()))
    for k in keys:
        g = (got or {}).get(k) if got else None
        tv = truth.get(k)
        if isinstance(tv, list) and isinstance(g, list):
            ok = all(a == b for a, b in zip(g, tv)) and len(g) == len(tv)
        else:
            ok = g == tv
        out[k] = {"truth": tv, "got": g, "ok": bool(ok)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-rect", action="store_true", help="保留 rectified 产物")
    ap.add_argument("--stem", help="只处理某一张图（case_id）")
    ap.add_argument("--reuse-ocr", action="store_true",
                    help="复用已缓存的 rectified/OCR，只重跑分类+提取（调参迭代用）")
    args = ap.parse_args()

    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
              "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)

    # classify/extract 在两种模式下都需要（调参后重跑分类+提取）
    from classify_ui import classify  # noqa: E402
    from extract_fields import extract_one, MACHINE_LABELS, RECORD_REPORT  # noqa: E402

    if args.reuse_ocr:
        # 仅调参迭代：跳过质量/矫正/OCR，复用 output/s03_hot_runner/rectified 下已缓存产物
        assess = lambda p: None  # noqa: E731
        rectify = lambda *a, **k: {"ok": True}  # noqa: E731
        ocr = None
    else:
        import cv2
        import numpy as np
        from quality import assess
        from rectify import rectify
        from postprocess import postprocess_one
        from ocr_variants import generate_clahe_sidecar
        # OCR 走 CPU（与 s02 repro 一致，避免环境 cudnn 差异；显式 use_gpu=False）
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        from paddleocr import PaddleOCR
        ocr = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False, use_gpu=False)
        ocr.ocr(np.zeros((100, 100, 3), dtype=np.uint8), cls=False)  # warmup

    OUT.mkdir(parents=True, exist_ok=True)
    rect_dir = OUT / "rectified"
    rect_dir.mkdir(exist_ok=True)

    record_report = json.loads(RECORD_REPORT.read_text()) if RECORD_REPORT.is_file() else None
    machine_labels = json.loads(MACHINE_LABELS.read_text()) if MACHINE_LABELS.is_file() else None

    report = []
    for case_id, (profile_dir, positive) in IMAGES.items():
        if args.stem and case_id != args.stem:
            continue
        src = CALIB / profile_dir / f"{case_id}.jpg"
        if not src.is_file():
            print(f"[s03] MISSING image {src}")
            continue
        stem = case_id
        tmp_png = rect_dir / f"{stem}.png"
        meta_path = rect_dir / f"{stem}.rectify.json"
        ocr_path = rect_dir / f"{stem}.ocr.json"
        if not args.reuse_ocr:
            # clear sidecars（复用模式保留已缓存 sidecar，不清理）
            for sc in ("ocr_clahe", "ocr_moire", "ocr_rates", "ocr_zoom", "ocr_hr"):
                (rect_dir / f"{stem}.{sc}.json").unlink(missing_ok=True)

            q = assess(src)
            rr = rectify(src, tmp_png, meta_path)
            ocr_target = tmp_png if rr["ok"] else src
            lines = run_ocr_lines(ocr, ocr_target)
            ocr_data = {
                "filename": src.name, "path": str(ocr_target),
                "model": "paddleocr-2.7.3 (s03 repro)", "line_count": len(lines), "lines": lines,
            }
            ocr_path.write_text(json.dumps(ocr_data, ensure_ascii=False, indent=2))
            postprocess_one(ocr_path)
        else:
            ocr_target = tmp_png if tmp_png.is_file() else src

        cls_res = classify(ocr_path)
        fam = str(cls_res.get("ui_family") or "").upper()
        if not args.reuse_ocr:
            # 5c clahe sidecar（仅 unknown 家族，与 service 一致）
            if fam.strip().lower() in ("", "unknown"):
                try:
                    generate_clahe_sidecar(ocr, ocr_target, rect_dir / f"{stem}.ocr_clahe.json")
                except Exception as e:  # noqa: BLE001
                    print(f"[s03] clahe variant failed {stem}: {e}")

        ext = extract_one(stem, rect_dir, record_report, machine_labels, ROOT / "templates")
        truth = load_truth(case_id, profile_dir)
        d = diff_fields(ext.get("fields"), truth.get("fields", {}) or {})
        n_ok = sum(1 for v in d.values() if v["ok"])
        n_total = len(d)
        # 负例（allow_auto_import=false）验收口径：status != ok 且无可应用字段
        if positive:
            case_pass = (ext.get("status") == "ok") and n_ok == n_total
        else:
            case_pass = ext.get("status") != "ok"
        entry = {
            "case_id": case_id, "profile_dir": profile_dir, "positive": positive,
            "status": ext.get("status"),
            "classification": cls_res,
            "controller_family": ext.get("controller_family"),
            "page_type": ext.get("page_type"),
            "profile_id": ext.get("profile_id"),
            "profile_status": ext.get("profile_status"),
            "warnings": ext.get("warnings", []),
            "diff": d,
            "fields_match": n_ok,
            "fields_total": n_total,
            "all_match": n_ok == n_total,
            "case_pass": case_pass,
        }
        report.append(entry)
        tag = "PASS" if case_pass else "FAIL"
        print(f"[s03] {case_id} [{profile_dir}] status={ext.get('status')} "
              f"{n_ok}/{n_total} fields {tag} cls={cls_res.get('ui_family')}/{cls_res.get('page')}")
        if positive and not entry["all_match"]:
            for k, v in d.items():
                if not v["ok"]:
                    print(f"     ! {k}: truth={v['truth']} got={v['got']}")
        if not positive and not case_pass:
            print(f"     ! negative case not rejected: fields={ext.get('fields')}")

    n_pass = sum(1 for e in report if e["case_pass"])
    print(f"[s03] {n_pass}/{len(report)} cases pass")
    (OUT / "repro_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"[s03] report -> {OUT/'repro_report.json'}")


if __name__ == "__main__":
    main()
