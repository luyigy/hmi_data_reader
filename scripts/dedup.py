"""SHA-256 去重：用于飞书附件样本的精确文件级去重。

输出 JSON 报告，含 3 类：
- duplicate_within_record：同一记录跨字段挂同一文件
- duplicate_across_records：跨机台/品牌记录挂同一文件
- unique：唯一文件

用法：
    python scripts/dedup.py <图片目录>... --output <report.json>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import defaultdict
from pathlib import Path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_filename(filename: str) -> tuple[str, str, str]:
    """从样本文件名解析（品牌前缀, 机台ID, Tab 名）。

    例: jiaming_Z052_t1_炮筒.jpeg -> ('jiaming', 'Z052', 't1_炮筒')
    """
    stem = Path(filename).stem
    parts = stem.split("_", 3)
    if len(parts) >= 4:
        return parts[0], parts[1], f"{parts[2]}_{parts[3]}"
    if len(parts) == 3:
        return parts[0], parts[1], parts[2]
    return "", "", stem


def scan(root: Path) -> list[dict]:
    rows = []
    for p in sorted(root.glob("*.jpeg")) + sorted(root.glob("*.jpg")) + sorted(root.glob("*.png")):
        brand, machine, tab = parse_filename(p.name)
        rows.append({
            "path": str(p),
            "filename": p.name,
            "size_bytes": p.stat().st_size,
            "sha256": sha256_file(p),
            "brand_label": brand,
            "machine_label": machine,
            "tab_label": tab,
        })
    return rows


def build_groups(rows: list[dict]) -> dict:
    by_hash: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_hash[r["sha256"]].append(r)

    duplicate_within_record = []
    duplicate_across_records = []
    unique = []

    for digest, group in by_hash.items():
        if len(group) == 1:
            unique.append(group[0])
            continue
        # 同 hash 出现多次 -> 重复组
        # 按"记录维度"分组：brand+machine 当作一个记录的代理（样本目录的命名约定）
        record_keys = {(g["brand_label"], g["machine_label"]) for g in group}
        if len(record_keys) == 1:
            # 同一记录：跨字段重复
            duplicate_within_record.append({
                "sha256": digest,
                "files": [g["filename"] for g in group],
                "tabs": [g["tab_label"] for g in group],
                "issue": "DUPLICATE_ATTACHMENT",
                "reason": f"同一记录 ({group[0]['brand_label']}/{group[0]['machine_label']}) 跨字段挂同一文件",
            })
        else:
            duplicate_across_records.append({
                "sha256": digest,
                "files": [g["filename"] for g in group],
                "records": [f"{g['brand_label']}/{g['machine_label']}" for g in group],
                "issue": "CROSS_RECORD_DUPLICATE",
                "reason": "跨机台/品牌记录挂同一文件，业务上不应复用",
            })
    return {
        "duplicate_within_record": duplicate_within_record,
        "duplicate_across_records": duplicate_across_records,
        "unique": unique,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("roots", nargs="+", help="图片目录（可多个）")
    ap.add_argument("--output", "-o", required=True, help="报告 JSON 路径")
    args = ap.parse_args()

    all_rows: list[dict] = []
    for root_str in args.roots:
        root = Path(root_str)
        if not root.is_dir():
            print(f"[WARN] skip {root} (not a directory)", file=sys.stderr)
            continue
        all_rows.extend(scan(root))

    if not all_rows:
        print(f"[ERROR] no images found in {args.roots}", file=sys.stderr)
        sys.exit(1)

    groups = build_groups(all_rows)

    report = {
        "total_files": len(all_rows),
        "unique_files": len(groups["unique"]),
        "duplicate_groups_within_record": len(groups["duplicate_within_record"]),
        "duplicate_groups_across_records": len(groups["duplicate_across_records"]),
        "duplicate_within_record": groups["duplicate_within_record"],
        "duplicate_across_records": groups["duplicate_across_records"],
        "unique": [r["filename"] for r in groups["unique"]],
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    # 人能看的简要输出
    print(f"[dedup] {len(all_rows)} files scanned")
    print(f"[dedup] {len(groups['duplicate_within_record'])} duplicate-within-record groups")
    print(f"[dedup] {len(groups['duplicate_across_records'])} duplicate-across-records groups")
    print(f"[dedup] report -> {args.output}")


if __name__ == "__main__":
    main()