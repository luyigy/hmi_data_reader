"""023 PLAN S1 聚焦检查：verify_accuracy 拒识计分口径（防滥拒绝/防错误放行）。

合成三类样本验证 scripts/verify_accuracy.py 的计分语义：
1. 正确拒识（allow_auto_import=false 且 status!=ok）→ 元素从 numeric/完整性计分排除，
   rejection_accuracy 计入分子；
2. 错误放行（allow_auto_import=false 但 status=ok 且数值错误）→ 不排除，
   numeric_accuracy 被拉低、error_auto_import_rate>0、rejection_accuracy<1，
   三门禁全部 FAIL——证明负样本不能靠排除分母获得 PASS；
3. 普通正样本照常计分。

运行：.venv/bin/python scripts/check_023_rejection_scoring.py（退出码 0 = 全部通过）
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

VENV_PY = sys.executable
VERIFY = Path(__file__).parent / "verify_accuracy.py"


def _truth(image: str, allow: bool, cur=(200.0, 210.0)) -> dict:
    return {
        "image": image, "controller_family": "B_AND_R", "page_type": "temperature",
        "allow_auto_import": allow,
        "fields": {"barrel_temperature_current_c": list(cur)},
    }


def _extracted(image: str, status: str, cur=(200.0, 210.0)) -> dict:
    stem = Path(image).stem
    return {
        "image": stem, "status": status, "controller_family": "B_AND_R",
        "page_type": "temperature", "heater_columns": 6,
        "fields": {"barrel_temperature_current_c": list(cur)}, "warnings": [],
    }


def run_case(tmp: Path, cases: list[tuple[dict, dict]]) -> dict:
    truth_dir = tmp / "truth"
    ext_dir = tmp / "extracted"
    truth_dir.mkdir()
    ext_dir.mkdir()
    for t, e in cases:
        (truth_dir / f"{Path(t['image']).stem}.truth.json").write_text(json.dumps(t))
        (ext_dir / f"{Path(t['image']).stem}.fields.json").write_text(json.dumps(e))
    out = tmp / "report.json"
    subprocess.run([VENV_PY, str(VERIFY), str(ext_dir), "--truth", str(truth_dir),
                    "-o", str(out)], check=True, capture_output=True)
    return json.loads(out.read_text())


def main() -> None:
    failures = []

    # 用例 1：正确拒识被排除，rejection_accuracy=1，数值口径不计其 null
    r = run_case(Path(tempfile.mkdtemp()), [
        (_truth("ok_img.jpeg", True), _extracted("ok_img.jpeg", "ok")),
        (_truth("alarm.jpeg", False), _extracted("alarm.jpeg", "reject",
                                                 cur=(None, None))),
    ])
    m, g, s = r["metrics"], r["gates"], r["scoring"]
    exp = {
        "numeric_accuracy == 1（正确拒识的 null 不计分）": m["numeric_accuracy"] == 1.0,
        "rejection_accuracy == 1": m["rejection_accuracy"] == 1.0,
        "排除图片=alarm": [x["image"] for x in s["excluded_images"]] == ["alarm.jpeg"],
        "全量 4 元素/计分 2 元素": (s["raw_totals"]["n_elements"] == 4
                                    and s["scored_totals"]["n_elements"] == 2),
        "gate rejection PASS": g["rejection_accuracy == 1"] is True,
    }

    # 用例 2：错误放行负样本不排除，三门禁全 FAIL（不能靠排除分母获 PASS）
    r2 = run_case(Path(tempfile.mkdtemp()), [
        (_truth("ok_img.jpeg", True), _extracted("ok_img.jpeg", "ok")),
        (_truth("alarm.jpeg", False), _extracted("alarm.jpeg", "ok",
                                                 cur=(999.0, 210.0))),
    ])
    m2, g2, s2 = r2["metrics"], r2["gates"], r2["scoring"]
    exp.update({
        "错误放行仍计入分母（4 元素）": s2["scored_totals"]["n_elements"] == 4,
        "numeric_accuracy 被拉低 (3/4)": m2["numeric_accuracy"] == 0.75,
        "error_auto_import_rate > 0": (m2["error_auto_import_rate"] or 0) > 0,
        "rejection_accuracy == 0": m2["rejection_accuracy"] == 0.0,
        "gate numeric FAIL": g2["numeric_accuracy >= 0.95"] is False,
        "gate error FAIL": g2["error_auto_import_rate == 0"] is False,
        "gate rejection FAIL": g2["rejection_accuracy == 1"] is False,
        "poc_pass False": r2["poc_pass"] is False,
        "无排除图片": s2["excluded_images"] == [],
    })

    # 用例 3：无负样本集 rejection 记 N/A，不宣称 PASS 也不阻塞其他门禁
    r3 = run_case(Path(tempfile.mkdtemp()), [
        (_truth("ok_img.jpeg", True), _extracted("ok_img.jpeg", "ok")),
    ])
    exp.update({
        "rejection_accuracy None（N/A）": r3["metrics"]["rejection_accuracy"] is None,
        "gate rejection 为 N/A": r3["gates"]["rejection_accuracy == 1"] == "N/A",
        "无负样本集 poc_pass 仍可为 True": r3["poc_pass"] is True,
    })

    for name, ok in exp.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        if not ok:
            failures.append(name)
    if failures:
        sys.exit(f"[check_023] {len(failures)} 项失败: {failures}")
    print(f"[check_023] {len(exp)} 项全部通过")


if __name__ == "__main__":
    main()
