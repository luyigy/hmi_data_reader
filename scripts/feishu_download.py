"""下载所有附件到 docs/samples_v2/"""
import json
import subprocess
from pathlib import Path

records = json.load(open('/tmp/feishu_pull/records.json'))
# record_id_list 在 metadata 里 — 需要从 record-list 响应里拿
# 重新拉一次拿 record_id_list
res = subprocess.run([
    "lark-cli", "base", "+record-list",
    "--base-token", "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc",
    "--table-id", "tbl1ACm7qNrrKsPc",
    "--view-id", "vewQb8HnsJ",
    "--limit", "200",
    "--format", "json",
    "--field-id", "品牌",
    "--field-id", "客户",
    "--field-id", "模具SAP索引",
    "--field-id", "日期",
    "--field-id", "成型条件-炮筒温度设定",
    "--field-id", "成型条件-射出/保压",
    "--field-id", "成型条件-储料/冷却",
    "--field-id", "成型条件-成型监控一/二",
    "--field-id", "成型条件-波形图",
    "--field-id", "工艺参数图片",
    "--field-id", "位置编号",
], capture_output=True, text=True)
full_data = json.loads(res.stdout)
record_ids = full_data["data"]["record_id_list"]
items = full_data["data"]["data"]
print(f"records: {len(record_ids)}, items: {len(items)}")
assert len(record_ids) == len(items)

FIELDS = [
    "品牌", "客户", "模具SAP索引", "日期",
    "成型条件-炮筒温度设定", "成型条件-射出/保压", "成型条件-储料/冷却",
    "成型条件-成型监控一/二", "成型条件-波形图", "工艺参数图片", "位置编号",
]
# 注塑机ID 投影失败，所以上面没列 — 实际字段顺序在 items 里就是 projection 顺序

ATTACHMENT_FIELDS = {
    "成型条件-炮筒温度设定": "炮筒",
    "成型条件-射出/保压": "射出",
    "成型条件-储料/冷却": "储料",
    "成型条件-成型监控一/二": "监控",
    "成型条件-波形图": "波形",
    "工艺参数图片": "工艺",
}

OUT_DIR = Path("/data1/code/hmi_data_reader/docs/samples_v2")
OUT_DIR.mkdir(parents=True, exist_ok=True)


def first_or_none(v):
    if v is None:
        return None
    if isinstance(v, list):
        if not v:
            return None
        if isinstance(v[0], dict) and "file_token" in v[0]:
            return v[0]
        return v[0] if v else None
    return v


def safe(s):
    if s is None:
        return "X"
    s = str(s).replace("/", "_").replace("\\", "_").replace(" ", "_")
    s = "".join(c for c in s if ord(c) < 128 or 0x4e00 <= ord(c) <= 0x9fff)
    return s[:40]


stats = {"downloaded": 0, "skipped_empty": 0, "errors": 0, "manifest": []}

for i, (rec, rec_id) in enumerate(zip(items, record_ids)):
    row = {FIELDS[k]: rec[k] if k < len(rec) else None for k in range(len(FIELDS))}
    brand = safe(first_or_none(row["品牌"]))
    loc = safe(first_or_none(row["位置编号"]))
    mold = safe(first_or_none(row["模具SAP索引"]))
    date = str(row.get("日期") or "?")[:10].replace("-", "")

    prefix = f"{brand}_{loc}_{mold}_{date}_rec{i:02d}"

    for fld_name, fld_short in ATTACHMENT_FIELDS.items():
        att = row.get(fld_name)
        if not isinstance(att, list) or not att:
            stats["skipped_empty"] += 1
            continue
        for j, file_info in enumerate(att):
            file_token = file_info.get("file_token")
            if not file_token:
                stats["errors"] += 1
                continue

            local_name = f"{prefix}_{fld_short}_{j:02d}.jpeg"
            local_path = OUT_DIR / local_name

            if local_path.exists() and local_path.stat().st_size > 0:
                stats["downloaded"] += 1
                continue

            # 用单文件下载模式：--output 指定**相对路径**，CLI 在 cwd 下保存
            tmp_name = f".tmp_{file_token[:12]}.jpeg"
            tmp_path_rel = tmp_name
            cmd = [
                "lark-cli", "base", "+record-download-attachment",
                "--base-token", "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc",
                "--table-id", "tbl1ACm7qNrrKsPc",
                "--record-id", rec_id,
                "--file-token", file_token,
                "--output", tmp_name,
                "--overwrite",
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, cwd=str(OUT_DIR))
            tmp_full = OUT_DIR / tmp_name
            if res.returncode != 0 or not tmp_full.exists():
                stats["errors"] += 1
                err = res.stderr[:200] if res.stderr else res.stdout[:200]
                print(f"  ERROR {local_name}: {err}")
                tmp_full.unlink(missing_ok=True)
                continue
            tmp_full.rename(local_path)

            stats["downloaded"] += 1
            stats["manifest"].append({
                "record_id": rec_id,
                "record_idx": i,
                "brand": brand, "loc": loc, "mold": mold, "date": date,
                "field": fld_name,
                "file_token": file_token,
                "local_name": local_name,
                "size": local_path.stat().st_size,
            })
            print(f"  ok [{i:02d}] {local_name}")

print(f"\n=== 下载统计 ===")
print(f"成功: {stats['downloaded']}")
print(f"空附件跳过: {stats['skipped_empty']}")
print(f"失败: {stats['errors']}")
manifest_path = OUT_DIR / "_manifest.json"
manifest_path.write_text(json.dumps(stats["manifest"], ensure_ascii=False, indent=2))
print(f"manifest -> {manifest_path}")