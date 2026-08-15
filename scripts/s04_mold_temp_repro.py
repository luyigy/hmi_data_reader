"""042 PLAN S04 复现/校准脚手架：忠实复刻 hmi_service.recognize 对 18 张模温图的处理
（质量 → 矫正 → OCR → 后处理 → 分类 → 条件 sidecar → 字段提取），并按 calibration/
regression 真值逐字段比对，输出对照报告。仅本地只读，不调用任何写接口、不联网。

用法：
    .venv/bin/python scripts/s04_mold_temp_repro.py [--keep-rect]
产物：output/s04_mold_temp/repro_report.json（每图 status/fields/warnings/diff/truth）
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
REGRESSION = ROOT / "datasets/regression"
OUT = ROOT / "output/s04_mold_temp"

# case_id -> (分区目录, profile 目录, 期望正例/负例)
IMAGES = {
    # 工业冷水机 LCD（非模温机）：全部负例，须稳定拒识
    "mt_slide_B03_2f1215de": (CALIB, "industrial_chiller.mold_temp.lcd_pv_set", False),
    "mt_slide_B03_527d7e25": (CALIB, "industrial_chiller.mold_temp.lcd_pv_set", False),
    "mt_slide_B03_7061d0f3": (CALIB, "industrial_chiller.mold_temp.lcd_pv_set", False),
    # 模具温度调节机 双数码管带小数：正例
    "mt_front_A02_15d33262": (CALIB, "mold_thermoregulator.mold_temp.pv_sv_decimal", True),
    "mt_front_A02_d8b6f05a": (CALIB, "mold_thermoregulator.mold_temp.pv_sv_decimal", True),
    "mt_rear_A02_f384426f": (CALIB, "mold_thermoregulator.mold_temp.pv_sv_decimal", True),
    "mt_slide_B05_1ec3c1ab": (CALIB, "mold_thermoregulator.mold_temp.pv_sv_decimal", True),
    # 模具温度调节机 双数码管整数：正例
    "mt_front_A11_82258780": (CALIB, "mold_thermoregulator.mold_temp.pv_sv_integer", True),
    "mt_rear_A11_10af110c": (CALIB, "mold_thermoregulator.mold_temp.pv_sv_integer", True),
    "mt_slide_B12_af783ea3": (CALIB, "mold_thermoregulator.mold_temp.pv_sv_integer", True),
    # Omron E5CC 单回路（AOLANTE/APM）：正例
    "mt_front_A04_f69799e9": (CALIB, "omron_e5cc.mold_temp.single_loop", True),
    "mt_front_B07_657ff3dd": (CALIB, "omron_e5cc.mold_temp.single_loop", True),
    "mt_rear_A04_051f4f39": (CALIB, "omron_e5cc.mold_temp.single_loop", True),
    "mt_rear_A04_c3272b43": (CALIB, "omron_e5cc.mold_temp.single_loop", True),
    "mt_rear_B07_83558101": (CALIB, "omron_e5cc.mold_temp.single_loop", True),
    "mt_rear_B07_fd01ca17": (CALIB, "omron_e5cc.mold_temp.single_loop", True),
    "mt_slide_A09_02a08adb": (CALIB, "omron_e5cc.mold_temp.single_loop", True),
    # regression：显示屏未点亮，负例
    "mt_front_A04_cad69193": (REGRESSION, "omron_e5cc.mold_temp.single_loop", False),
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


def load_truth(case_id: str, partition: Path, profile_dir: str) -> dict:
    import yaml
    d = partition / profile_dir
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
        # 仅调参迭代：跳过质量/矫正/OCR，复用 output/s04_mold_temp/rectified 下已缓存产物
        assess = lambda p: None  # noqa: E731
        rectify = lambda *a, **k: {"ok": True}  # noqa: E731
        ocr = None
    else:
        import cv2
        import numpy as np
        from quality import assess
        from rectify import rectify
        from postprocess import postprocess_one
        from ocr_variants import generate_clahe_sidecar, generate_mold_temp_display_sidecar
        # OCR 走 CPU（与 s02/s03 repro 一致，避免环境 cudnn 差异；显式 use_gpu=False）
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
    for case_id, (partition, profile_dir, positive) in IMAGES.items():
        if args.stem and case_id != args.stem:
            continue
        src = partition / profile_dir / f"{case_id}.jpg"
        if not src.is_file():
            print(f"[s04] MISSING image {src}")
            continue
        stem = case_id
        tmp_png = rect_dir / f"{stem}.png"
        meta_path = rect_dir / f"{stem}.rectify.json"
        ocr_path = rect_dir / f"{stem}.ocr.json"
        if not args.reuse_ocr:
            # clear sidecars（复用模式保留已缓存 sidecar，不清理）
            for sc in ("ocr_clahe", "ocr_moire", "ocr_rates", "ocr_zoom", "ocr_hr", "ocr_mt"):
                (rect_dir / f"{stem}.{sc}.json").unlink(missing_ok=True)

            q = assess(src)
            rr = rectify(src, tmp_png, meta_path)
            ocr_target = tmp_png if rr["ok"] else src
            lines = run_ocr_lines(ocr, ocr_target)
            ocr_data = {
                "filename": src.name, "path": str(ocr_target),
                "model": "paddleocr-2.7.3 (s04 repro)", "line_count": len(lines), "lines": lines,
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
                    print(f"[s04] clahe variant failed {stem}: {e}")
                # 5e 模温机数码管旁车（042 S04，与 service 一致；矫正图+原图双源）
                try:
                    mt_sources = [(ocr_target, "mt_cell")]
                    if ocr_target != src:
                        mt_sources.append((src, "mt_cell_orig"))
                    generate_mold_temp_display_sidecar(ocr, mt_sources, rect_dir / f"{stem}.ocr_mt.json")
                except Exception as e:  # noqa: BLE001
                    print(f"[s04] mt display variant failed {stem}: {e}")

        ext = extract_one(stem, rect_dir, record_report, machine_labels, ROOT / "templates")
        truth = load_truth(case_id, partition, profile_dir)
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
        print(f"[s04] {case_id} [{profile_dir}] status={ext.get('status')} "
              f"{n_ok}/{n_total} fields {tag} cls={cls_res.get('ui_family')}/{cls_res.get('page')}")
        if positive and not entry["all_match"]:
            for k, v in d.items():
                if not v["ok"]:
                    print(f"     ! {k}: truth={v['truth']} got={v['got']}")
        if not positive and not case_pass:
            print(f"     ! negative case not rejected: fields={ext.get('fields')}")

    n_pass = sum(1 for e in report if e["case_pass"])
    print(f"[s04] {n_pass}/{len(report)} cases pass")
    (OUT / "repro_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"[s04] report -> {OUT/'repro_report.json'}")


if __name__ == "__main__":
    main()
