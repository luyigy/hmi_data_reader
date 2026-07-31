"""013 S1 校准集跑分：对 output/calibration_set_s1.json 中的图片跑质量门禁 + 透视矫正，输出拒识率/矫正成功率。

整改前（--tag pre）与整改后（--tag post）用同一脚本同一口径，保证可比。
矫正产物落在 output/s1_calibration/<tag>/，报告落在 output/s1_calibration_<tag>.json。

用法：
    python scripts/s1_calibration_run.py --tag pre
    python scripts/s1_calibration_run.py --tag post
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from quality import assess  # noqa: E402
from rectify import rectify  # noqa: E402

CALIBRATION_SET = Path("output/calibration_set_s1.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True, help="pre | post | 任意标签，决定输出文件名")
    ap.add_argument("--manifest", default=str(CALIBRATION_SET))
    args = ap.parse_args()

    manifest = json.loads(Path(args.manifest).read_text())
    out_dir = Path("output/s1_calibration") / args.tag
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    counts = {"green": 0, "yellow": 0, "red": 0}
    rect_counts = {"corners": 0, "bbox_fallback": 0, "failed": 0}
    for item in manifest["images"]:
        src = Path(item["path"])
        qr = assess(src)
        counts[qr.triage] += 1
        stem = src.stem
        rect_png = out_dir / f"{stem}.png"
        rect_meta = out_dir / f"{stem}.rectify.json"
        rr = rectify(src, rect_png, rect_meta)
        if rr["ok"]:
            rect_counts[rr.get("method", "corners") if rr.get("method") in rect_counts else "corners"] += 1
        else:
            rect_counts["failed"] += 1
        rows.append({
            "path": item["path"],
            "family": item["family"],
            "challenge": item["challenge"],
            "triage": qr.triage,
            "reject_codes": qr.reject_codes,
            "warn_codes": qr.warn_codes,
            "metrics": asdict(qr.metrics),
            "rectify_ok": rr["ok"],
            "rectify_method": rr.get("method"),
            "rectify_reason": rr.get("reason"),
        })
        print(f"  {src.name}: triage={qr.triage} reject={qr.reject_codes} "
              f"rectify={'ok:' + str(rr.get('method')) if rr['ok'] else 'FAIL:' + str(rr.get('reason'))}")

    n = len(rows)
    report = {
        "tag": args.tag,
        "manifest": args.manifest,
        "total": n,
        "quality_summary": counts,
        "quality_red_rate": counts["red"] / n if n else 0.0,
        "rectify_summary": rect_counts,
        "rectify_success_rate": (rect_counts["corners"] + rect_counts["bbox_fallback"]) / n if n else 0.0,
        # 链路口径的拒识：红档直接拒 + 非红档但矫正失败走 MANUAL_SCREEN_CONFIRM
        "rejected_or_manual": sum(1 for r in rows if r["triage"] == "red" or not r["rectify_ok"]),
        "rows": rows,
    }
    out_path = Path(f"output/s1_calibration_{args.tag}.json")
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"-> {out_path} (n={n} red={counts['red']} rectify_fail={rect_counts['failed']} "
          f"rejected_or_manual={report['rejected_or_manual']})")


if __name__ == "__main__":
    main()
