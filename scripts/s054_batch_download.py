"""054 PLAN S01：温度附件分批只读下载（每批最多 30 张 + SHA-256 去重 + checkpoint）。

复用 feishu_download_v3 的 Base 查询与附件下载链路，不重写下载器；本脚本只补齐
054 PLAN §3.1 要求的差距：
- 仅 5 个温度附件字段（炮筒/热流道/模温机前模/后模/行位）；
- 单批最多 30 张（硬上限，不可调大）；
- 先落 .part，校验非空、图片签名（JPEG/PNG）、声明大小后原子改名；
- 内容级 SHA-256 去重：对已知样本集（calibration/regression/samples_*）与批内
  双重去重，命中已知 hash 的图立即删除，不占用新批名额以外的存储；
- 每批完成后写 manifest checkpoint（不含 file token/分享 URL/凭证），可续跑。

用法：
    python3 scripts/s054_batch_download.py --batch-id batch_001 \
        --known-hashes output/s054_known_hashes.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from feishu_download_v3 import TABLE, api, list_all_records, safe, text_of  # noqa: E402

MAX_BATCH = 30
TEMP_FIELDS = {
    "成型条件-炮筒温度设定": "barrel",
    "成型条件-热流道温控箱温度": "hot_runner",
    "成型条件-模温机前模": "mold_temp_front",
    "成型条件-模温机后模": "mold_temp_rear",
    "成型条件-模温机行位": "mold_temp_slide",
}
# 类别优先级与默认上限：炮筒伯乐（B&R 已验证 Profile 复核）与模温新布局优先
CATEGORY_ORDER = ["barrel", "hot_runner", "mold_temp_front", "mold_temp_rear",
                  "mold_temp_slide"]
DEFAULT_CAPS = {"barrel": 7, "hot_runner": 3, "mold_temp_front": 9,
                "mold_temp_rear": 9, "mold_temp_slide": 2}

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def is_image(path: Path) -> bool:
    head = path.read_bytes()[:8]
    return head.startswith(JPEG_MAGIC) or head.startswith(PNG_MAGIC)


def load_used_pairs(manifest_path: Path) -> set:
    """samples_temperature_base manifest 的 (record_id, field) 已下载对。"""
    used = set()
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    for cdata in (data.get("categories") or {}).values():
        for s in cdata.get("samples", []):
            used.add((s.get("record_id"), s.get("field")))
    return used


def load_checkpoint_pairs(paths: list[Path]) -> set:
    return {
        (entry.get("record_id"), entry.get("field"))
        for path in paths
        for entry in json.loads(path.read_text(encoding="utf-8")).get("entries", [])
    }


def load_checkpoint_hashes(paths: list[Path]) -> set:
    return {
        entry["sha256"]
        for path in paths
        for entry in json.loads(path.read_text(encoding="utf-8")).get("entries", [])
        if entry.get("sha256")
    }


def collect_candidates(used_pairs: set) -> list[dict]:
    """只读查询 Base，返回未下载过的温度附件候选（稳定顺序）。"""
    records = list_all_records()
    candidates = []
    for rec in sorted(records, key=lambda r: r["record_id"]):
        f = rec["fields"]
        brand = text_of(f.get("品牌"))
        loc = text_of(f.get("位置编号"))
        machine = text_of(f.get("注塑机ID"))
        for fld_name, category in TEMP_FIELDS.items():
            if (rec["record_id"], fld_name) in used_pairs:
                continue
            att = f.get(fld_name)
            if not isinstance(att, list):
                continue
            for info in att:
                token = info.get("file_token")
                if not token:
                    continue
                candidates.append({
                    "record_id": rec["record_id"], "field": fld_name,
                    "category": category, "brand": brand, "loc": loc,
                    "machine": machine, "original_name": info.get("name"),
                    "declared_size": info.get("size"), "file_token": token,
                })
    return candidates


def select_batch(candidates: list[dict], caps: dict, batch_size: int) -> list[dict]:
    """按类别优先级与上限选一批；剩余名额按同一次序递补。"""
    by_cat = {c: [] for c in CATEGORY_ORDER}
    for cand in candidates:
        by_cat.setdefault(cand["category"], []).append(cand)
    picked, leftover = [], []
    for cat in CATEGORY_ORDER:
        pool = by_cat.get(cat, [])
        picked.extend(pool[: caps.get(cat, 0)])
        leftover.extend(pool[caps.get(cat, 0):])
    for cand in leftover:
        if len(picked) >= batch_size:
            break
        picked.append(cand)
    return picked[:batch_size]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--batch-id", required=True, help="如 batch_001")
    ap.add_argument("--batch-size", type=int, default=MAX_BATCH)
    ap.add_argument("--out", default="output/s054_download")
    ap.add_argument("--known-hashes", default="output/s054_known_hashes.json")
    ap.add_argument("--exclude-manifest",
                    default="docs/samples_temperature_base/manifest.json")
    ap.add_argument("--exclude-checkpoint", action="append", default=[])
    args = ap.parse_args()
    if args.batch_size > MAX_BATCH:
        sys.exit(f"[s054] ERROR: 单批硬上限 {MAX_BATCH} 张，拒绝 --batch-size={args.batch_size}")

    out_dir = Path(args.out) / args.batch_id
    out_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = Path(args.out) / f"checkpoint_{args.batch_id}.json"
    if checkpoint_path.exists():
        sys.exit(f"[s054] ERROR: checkpoint 已存在 {checkpoint_path}，"
                 f"该批已完成；下一批请用新的 --batch-id")

    checkpoint_paths = [Path(p) for p in args.exclude_checkpoint]
    known = set(json.loads(Path(args.known_hashes).read_text(encoding="utf-8")))
    known = {h.replace("sha256:", "") for h in known}
    known |= load_checkpoint_hashes(checkpoint_paths)
    used_pairs = load_used_pairs(Path(args.exclude_manifest))
    used_pairs |= load_checkpoint_pairs(checkpoint_paths)

    candidates = collect_candidates(used_pairs)
    print(f"[s054] 未下载温度附件候选: {len(candidates)}")
    batch = select_batch(candidates, DEFAULT_CAPS, args.batch_size)
    print(f"[s054] 本批 {args.batch_id} 选定 {len(batch)} 张（上限 {args.batch_size}）")

    entries, seen_batch = [], {}
    stats = {"kept": 0, "dup_known": 0, "dup_batch": 0, "error": 0}
    for cand in batch:
        ext = Path(cand["original_name"] or "x.jpg").suffix.lower() or ".jpg"
        stem = "_".join(safe(x) for x in (
            cand["category"], cand["brand"], cand["loc"], cand["record_id"]))
        part = out_dir / f".{stem}.part"
        entry = {k: cand[k] for k in ("record_id", "field", "category", "brand",
                                      "loc", "machine", "original_name",
                                      "declared_size")}
        try:
            extra = json.dumps({"bitablePerm": {"tableId": TABLE, "rev": 0}},
                               separators=(",", ":"))
            api("GET", f"/open-apis/drive/v1/medias/{cand['file_token']}/download",
                params={"extra": extra}, output=str(part))
            if not part.exists() or part.stat().st_size == 0:
                raise RuntimeError("empty download")
            if not is_image(part):
                raise RuntimeError("not a JPEG/PNG image")
            if (cand["declared_size"]
                    and part.stat().st_size != cand["declared_size"]):
                raise RuntimeError(
                    f"size mismatch {part.stat().st_size} != {cand['declared_size']}")
            digest = sha256_of(part)
            entry["sha256"] = digest
            entry["size"] = part.stat().st_size
            if digest in known:
                entry["status"] = "duplicate_known"
                stats["dup_known"] += 1
                part.unlink()
            elif digest in seen_batch:
                entry["status"] = "duplicate_batch"
                entry["duplicate_of"] = seen_batch[digest]
                stats["dup_batch"] += 1
                part.unlink()
            else:
                final = out_dir / f"{stem}_{digest[:12]}{ext}"
                part.rename(final)
                entry["status"] = "kept"
                entry["saved_name"] = final.name
                seen_batch[digest] = final.name
                stats["kept"] += 1
                print(f"  ok {final.name}")
        except Exception as e:  # noqa: BLE001
            entry["status"] = "error"
            entry["error"] = str(e)
            stats["error"] += 1
            part.unlink(missing_ok=True)
            print(f"  ERROR {stem}: {e}", file=sys.stderr)
        entries.append(entry)

    checkpoint = {
        "batch_id": args.batch_id,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "scripts/s054_batch_download.py (054 PLAN S01)",
        "batch_size_limit": args.batch_size,
        "selected": len(batch),
        "stats": stats,
        "entries": entries,
        "notes": ["manifest 不含 file token/分享 URL/凭证；duplicate_known 命中"
                  " output/s054_known_hashes.json（calibration/regression/已见样本）"],
    }
    tmp = checkpoint_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.rename(checkpoint_path)
    print(f"[s054] stats: {stats}")
    print(f"[s054] checkpoint -> {checkpoint_path}")


if __name__ == "__main__":
    main()
