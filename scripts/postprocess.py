"""OCR 后处理智能化（路径 B）
目标：在不重拍、不换引擎的前提下，提升 OCR 输出数字的可用性。

四类修复：
1. 品牌字符串模糊匹配（解决 FANUC→NUC, BOLE→BELE 等 OCR 漏字）
2. 同行文本合并（解决 "设定°C" + "262.0" 被切成两段）
3. 数字字段范围约束（解决小数点漂移 + 单位识别）
4. 字段位置模板（基于各家族布局，约束数字应该在哪个 x/y 范围）

输入：output/json/*.ocr.json
输出：output/json/*.ocr.postprocessed.json (附加 fix_log)
"""
import json
import re
import sys
from pathlib import Path
from collections import defaultdict
from difflib import get_close_matches

# 后处理版本号：S2 聚合报告（scripts/aggregate_record.py）固化 OCR 快照时读取
__version__ = "0.1.0"

OCR_DIR = Path("output/json")
OUT_DIR = Path("output/json")

# 1. 品牌字符串模糊匹配
# 已知 UI 家族 + 模糊匹配关键词（OCR 漏字兜底）
UI_FAMILY_KEYWORDS = {
    "TACT": ["TACT", "tact", "TAC", "ACT", "T4CT", "FXI"],
    "FANUC": ["FANUC", "ROBOSHOT", "ROBO", "α-S30", "S-iA", "S-iB", "NUC", "FAN", "FAMC"],
    "ZizES": ["ZES", "ZizES", "佳明", "广东佳明", "广东佳"],
    "TRD6": ["TRD6", "SPT", "沙迪克", "Sodick", "TRD", "SDT"],
    "BOLE": ["BOLE", "Bole", "BELE", "BOL", "BLE", "Process expert", "PROCESS EXPERT"],
    "ARBURG": ["ARBURG", "Arburg", "ARBUR", "ARB", "ALTRONIC"],
    "DEMAG": ["DEMAG", "Demag", "DEHAG", "DEMG", "NC4"],
}


def fuzzy_match_brand(text: str) -> tuple[str, float] | None:
    """模糊匹配品牌字符串，1-edit-distance 内命中即返回 (family, conf)."""
    # 长度太短或包含中文的不做模糊匹配
    if len(text) < 3 or any(0x4e00 <= ord(c) <= 0x9fff for c in text):
        return None
    text_upper = text.upper().strip()
    for family, keywords in UI_FAMILY_KEYWORDS.items():
        for kw in keywords:
            if kw.upper() in text_upper:
                return (family, 1.0)
        # 模糊匹配
        all_keywords = [k.upper() for k in keywords if k.isascii()]
        match = get_close_matches(text_upper, all_keywords, n=1, cutoff=0.7)
        if match:
            return (family, 0.85)
    return None


# 2. 同行文本合并
def merge_same_line(lines: list, y_tolerance: int = 15) -> list:
    """按 y 合并同一行的 text（bbox y 在 y_tolerance 内视为同一行）。
    输出按 (avg_y, x_min) 排序的合并行。
    """
    if not lines:
        return []
    # 按 y_min 排序
    sorted_lines = sorted(lines, key=lambda l: l["bbox"]["y_min"])
    groups = []
    current = [sorted_lines[0]]
    for ln in sorted_lines[1:]:
        prev_y = sum(l["bbox"]["y_min"] for l in current) / len(current)
        if abs(ln["bbox"]["y_min"] - prev_y) <= y_tolerance:
            current.append(ln)
        else:
            groups.append(current)
            current = [ln]
    groups.append(current)

    merged = []
    for grp in groups:
        # 按 x_min 排序
        grp_sorted = sorted(grp, key=lambda l: l["bbox"]["x_min"])
        text = " ".join(l["text"] for l in grp_sorted)
        # 平均 y + 平均 x_min + 最低 conf
        avg_y = sum(l["bbox"]["y_min"] for l in grp_sorted) / len(grp_sorted)
        x_min = grp_sorted[0]["bbox"]["x_min"]
        x_max = max(l["bbox"]["x_max"] for l in grp_sorted)
        y_min = min(l["bbox"]["y_min"] for l in grp_sorted)
        y_max = max(l["bbox"]["y_max"] for l in grp_sorted)
        min_conf = min(l["conf"] for l in grp_sorted)
        avg_conf = sum(l["conf"] for l in grp_sorted) / len(grp_sorted)
        merged.append({
            "text": text,
            "bbox": {
                "x_min": x_min, "x_max": x_max,
                "y_min": y_min, "y_max": y_max,
                "avg_y": avg_y,
            },
            "conf": avg_conf,
            "min_conf": min_conf,
            "n_segments": len(grp_sorted),
        })
    return merged


# 3. 数字字段范围约束
# 各家族温度/压力典型范围（基于 OCR 已知数据）
FIELD_RANGES = {
    "temperature_now": (0, 350),    # °C 实际温度
    "temperature_set": (0, 350),    # °C 设定温度
    "temperature_oil": (0, 100),    # 油温
    "injection_pressure": (0, 250),  # MPa 射出压力
    "cycle_time": (0, 300),          # 秒 周期时间
    "fill_time": (0, 30),            # 秒 充填时间
    "melt_time": (0, 30),            # 秒 熔胶时间
    "back_pressure": (0, 30),        # bar
    "screw_position": (0, 300),      # mm
    "mold_thickness": (0, 1000),     # mm
    "control_percent": (0, 100),     # % PID 控制
}


def constrain_number(text: str, field_hint: str | None = None) -> tuple[float | None, str | None]:
    """根据字段范围约束修正数字。返回 (修正后数字, hint)。"""
    m = re.match(r'^-?(\d+\.?\d*|\.\d+)$', text.strip())
    if not m:
        return (None, "not_a_number")
    num = float(m.group(1))
    # 如果带了小数点漂移（如 2620 应该是 262.0），尝试按范围修正
    if field_hint and field_hint in FIELD_RANGES:
        lo, hi = FIELD_RANGES[field_hint]
        if num > hi and num < hi * 10:
            # 怀疑多了 1 位整数位（如 2620 → 262.0）
            candidate = num / 10
            if lo <= candidate <= hi:
                return (candidate, f"fixed_decimal_drift /10 [{lo}, {hi}]")
        if num < lo / 10 and num > 0:
            # 怀疑少了 1 位小数位（如 26 → 260），但更保守，不做
            pass
    return (num, None)


# 4. 字段位置模板（各家族）
# 这是文档化的：每个家族的数字在屏幕哪个区域
# 简化版：只标"温度数字在屏幕中部 1/3"
FIELD_REGIONS = {
    "ZizES": {  # 已知温度页布局
        "temperature_rows": {"y_min": 250, "y_max": 700},  # 加热段数字行
        "temperature_cols": {"x_min": 600, "x_max": 1500},
    },
    "FANUC": {
        "temperature_rows": {"y_min": 200, "y_max": 600},
        "temperature_cols": {"x_min": 800, "x_max": 1800},
    },
    # 其他家族先空，后续按 OCR 数据反推
}


def postprocess_one(ocr_path: Path) -> dict:
    data = json.loads(ocr_path.read_text())
    lines = data.get("lines", [])
    fix_log = []

    # 1. 品牌模糊匹配
    for ln in lines:
        text = ln["text"]
        match = fuzzy_match_brand(text)
        if match:
            family, conf = match
            if conf >= 1.0:
                fix_log.append(f"  [brand-exact] '{text}' -> {family} (conf=1.0)")
            else:
                fix_log.append(f"  [brand-fuzzy] '{text}' -> {family} (conf={conf}, fuzzy-match)")

    # 2. 同行文本合并
    merged = merge_same_line(lines, y_tolerance=15)
    fix_log.append(f"  [merge-lines] {len(lines)} lines -> {len(merged)} merged rows")

    # 3. 数字字段范围约束（针对合并后的行）
    number_count = 0
    fixed_count = 0
    for row in merged:
        text = row["text"]
        # 提取行内所有数字
        numbers = re.findall(r'-?\d+\.?\d*', text)
        for num_str in numbers:
            num, hint = constrain_number(num_str)
            if num is not None:
                number_count += 1
            if hint:
                fixed_count += 1
                fix_log.append(f"  [number-fix] '{num_str}' -> {num} ({hint})")

    fix_log.append(f"  [number-stats] {number_count} numbers found, {fixed_count} fixed")

    # 4. 字段位置模板（暂只输出统计）
    fix_log.append(f"  [field-template] {len(FIELD_REGIONS)} families have templates (ZizES + FANUC)")

    return {
        "filename": data["filename"],
        "path": data["path"],
        "line_count": data["line_count"],
        "merged_rows": merged,
        "fix_log": fix_log,
        "stats": {
            "n_lines": len(lines),
            "n_merged_rows": len(merged),
            "n_numbers": number_count,
            "n_numbers_fixed": fixed_count,
        },
    }


def main():
    if not OCR_DIR.exists():
        print(f"OCR_DIR not found: {OCR_DIR}")
        return
    files = sorted(OCR_DIR.glob("*.ocr.json"))
    if not files:
        print("No OCR JSON files found")
        return

    out_files = []
    for p in files:
        result = postprocess_one(p)
        out_path = OUT_DIR / (p.stem + ".postprocessed.json")
        out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        out_files.append(out_path)

    print(f"✓ 后处理完成: {len(out_files)} 张图")
    # 总统计
    total_numbers = 0
    total_fixed = 0
    for p in out_files:
        r = json.loads(p.read_text())
        total_numbers += r["stats"]["n_numbers"]
        total_fixed += r["stats"]["n_numbers_fixed"]
    print(f"  数字总数: {total_numbers}")
    print(f"  修正数: {total_fixed} ({100*total_fixed/max(total_numbers,1):.1f}%)")


if __name__ == "__main__":
    main()