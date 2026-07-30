"""S2：按获批候选清单下载 holdout 附件并做内容级 SHA-256 去重。

009_PLAN S2 工作项 1 的机械部分：
- 只下载 `output/zizes_expansion_candidates.json`（status=APPROVED）中的 18 目标 + 12 候补；
- 每个文件计算 SHA-256，内容重复的目标按候选清单固定顺序（rank 19→30）用候补替换，
  不临时人工挑图；
- 产出 `output/holdout_sample_manifest.json` 与图片目录 `docs/samples_v4_holdout/`。

非 ZIZES / 非温度页 / 无法建立真值的判定需要读图，在后续 VLM 预标注阶段执行，
届时仍按同一候补固定顺序替换。

用法：
    python3 scripts/s2_download_holdout.py
"""
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE = "tbl5KKYuANqGpycE"
CANDIDATES = Path("output/zizes_expansion_candidates.json")
OUT_DIR = Path("docs/samples_v4_holdout")
MANIFEST = Path("output/holdout_sample_manifest.json")


def api(method, path, **kwargs):
    cmd = ["lark-cli", "api", method, path, "--as", "bot"]
    if "params" in kwargs:
        cmd += ["--params", json.dumps(kwargs["params"], ensure_ascii=False)]
    if "output" in kwargs:
        cmd += ["-o", kwargs["output"]]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"{method} {path} failed: {res.stderr or res.stdout}")
    if "output" in kwargs:
        return None
    return json.loads(res.stdout)


def download(file_token, out_path: Path):
    extra = json.dumps({"bitablePerm": {"tableId": TABLE, "rev": 0}}, separators=(",", ":"))
    tmp = out_path.with_suffix(".tmp")
    try:
        api("GET", f"/open-apis/drive/v1/medias/{file_token}/download",
            params={"extra": extra}, output=str(tmp))
        if not tmp.exists() or tmp.stat().st_size == 0:
            raise RuntimeError("empty download")
        tmp.rename(out_path)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"  ERROR {out_path.name}: {e}", file=sys.stderr)
        tmp.unlink(missing_ok=True)
        return False


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def local_name(entry):
    date = (entry.get("date") or "unknown").replace("-", "")
    return f"holdout_{entry['machine']}_{date}_rank{entry['rank']:02d}_{entry['record_id']}.jpeg"


def main():
    cand = json.loads(CANDIDATES.read_text())
    if cand.get("status") != "APPROVED":
        sys.exit(f"候选清单状态为 {cand.get('status')}，未获用户批准，禁止下载")
    entries = cand["targets"] + cand["alternates"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 1) 下载全部 30 条并计算 SHA-256
    pool = []
    for e in entries:
        name = local_name(e)
        path = OUT_DIR / name
        if not path.exists() or path.stat().st_size == 0:
            print(f"download rank{e['rank']:02d} {e['machine']} {e['date']} ...")
            if not download(e["file_token"], path):
                pool.append({**e, "local_name": None, "download_error": True})
                continue
        item = {**e, "local_name": name, "sha256": sha256_of(path),
                "bytes_downloaded": path.stat().st_size,
                "size_matches_metadata": path.stat().st_size == e.get("attachment_size_bytes")}
        pool.append(item)
        print(f"  ok {name} sha256={item['sha256'][:12]} size_ok={item['size_matches_metadata']}")

    # 2) 内容级去重 + 目标替换（候补按 rank 固定顺序顺延，不人工挑图）
    seen = {}  # sha256 -> 首个持有者 rank
    final_targets, replaced, used_ranks = [], [], set()

    def take(entry, role):
        seen.setdefault(entry["sha256"], entry["rank"])
        used_ranks.add(entry["rank"])
        final_targets.append({"rank": entry["rank"], "role": role, **entry})

    for e in [p for p in pool if p["rank"] <= 18 and not p.get("download_error")]:
        if e["sha256"] in seen:
            replaced.append({"target_rank": e["rank"], "record_id": e["record_id"],
                             "sha256": e["sha256"], "duplicate_of_rank": seen[e["sha256"]]})
            continue
        take(e, "original_target")

    for e in [p for p in pool if p["rank"] > 18 and not p.get("download_error")]:
        if len(final_targets) >= 18:
            break
        if e["sha256"] in seen:
            replaced.append({"alternate_rank": e["rank"], "record_id": e["record_id"],
                             "sha256": e["sha256"], "duplicate_of_rank": seen[e["sha256"]],
                             "skipped": True})
            continue
        take(e, "replacement_alternate")

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "kimi-code S2 (009_PLAN)",
        "source_candidates": str(CANDIDATES),
        "approval": cand.get("approval"),
        "image_dir": str(OUT_DIR),
        "final_target_count": len(final_targets),
        "final_targets": final_targets,
        "content_duplicates": replaced,
        "download_errors": [p["record_id"] for p in pool if p.get("download_error")],
        "remaining_alternates": [p["rank"] for p in pool
                                 if p["rank"] > 18 and p["rank"] not in used_ranks
                                 and not p.get("download_error")],
        "notes": [
            "去重为内容级 SHA-256；非温度页/无法建立真值项待 VLM 预标注阶段判定后按候补固定顺序替换",
            "legacy 5 张校准样本不在本清单内，S3 单列回归",
        ],
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"\nfinal targets: {len(final_targets)}/18, duplicates replaced/skipped: {len(replaced)}")
    print(f"manifest -> {MANIFEST}")


if __name__ == "__main__":
    main()
