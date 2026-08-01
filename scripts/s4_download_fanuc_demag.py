"""026_PLAN S1：按获批 FANUC/DEMAG 候选清单下载附件并做内容级 SHA-256 去重。

克隆自 scripts/s3_download_bole.py（013 S3 伯乐），差异：
- 候选清单 `output/fanuc_demag_candidates.json`（status=APPROVED），18 目标 + 12 候补；
- 产物目录 `docs/samples_fanuc_demag/`；文件名前缀按品牌 fanuc_/demag_；
- 本地排重参照改为发那科/德马格相关：samples_v2 对应品牌样图 + S1 校准集对应图。

非 FANUC/DEMAG / 非温度页 / 无法建立真值的判定需要读图，在后续 VLM 预标注阶段执行，
届时仍按同一候补固定顺序替换。

用法：
    python3 scripts/s4_download_fanuc_demag.py
"""
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE = "tbl5KKYuANqGpycE"
CANDIDATES = Path("output/fanuc_demag_candidates.json")
OUT_DIR = Path("docs/samples_fanuc_demag")
MANIFEST = Path("output/fanuc_demag_sample_manifest.json")
N_TARGETS = 18

BRAND_PREFIX = {"发那科": "fanuc", "德马格": "demag"}

# 本地已有发那科/德马格样图（内容级排重参照）
LOCAL_REFERENCE_GLOBS = [
    "docs/samples_v2/发那科_*.jpeg",
    "docs/samples_v2/发那科_*.jpg",
    "docs/samples_v2/发那科_*.png",
    "docs/samples_v2/德马格_*.jpeg",
    "docs/samples_v2/德马格_*.jpg",
    "docs/samples_v2/德马格_*.png",
]


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
    prefix = BRAND_PREFIX.get(entry.get("brand"), "unknown")
    return f"{prefix}_{entry['machine']}_{date}_rank{entry['rank']:02d}_{entry['record_id']}.jpeg"


def local_reference_hashes():
    """本地已有发那科/德马格样图的内容哈希（含 S1 校准集对应图）。"""
    refs = {}
    for pat in LOCAL_REFERENCE_GLOBS:
        for p in sorted(Path(".").glob(pat)):
            refs.setdefault(sha256_of(p), str(p))
    cal = Path("output/calibration_set_s1.json")
    if cal.exists():
        for item in json.loads(cal.read_text()).get("images", []):
            p = Path(item.get("path", ""))
            if p.exists() and ("发那科" in p.name or "德马格" in p.name):
                refs.setdefault(sha256_of(p), str(p))
    return refs


def main():
    cand = json.loads(CANDIDATES.read_text())
    if cand.get("status") != "APPROVED":
        sys.exit(f"候选清单状态为 {cand.get('status')}，未获用户批准，禁止下载")
    entries = cand["targets"] + cand["alternates"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 0) 本地参照哈希
    local_refs = local_reference_hashes()
    print(f"local reference images: {len(local_refs)}")

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
    seen = {}  # sha256 -> 首个持有者描述
    final_targets, replaced, used_ranks = [], [], set()

    def take(entry, role):
        seen.setdefault(entry["sha256"], f"rank{entry['rank']}")
        used_ranks.add(entry["rank"])
        final_targets.append({"rank": entry["rank"], "role": role, **entry})

    for e in [p for p in pool if p["rank"] <= N_TARGETS and not p.get("download_error")]:
        if e["sha256"] in seen:
            replaced.append({"target_rank": e["rank"], "record_id": e["record_id"],
                             "sha256": e["sha256"], "duplicate_of": seen[e["sha256"]]})
            continue
        if e["sha256"] in local_refs:
            replaced.append({"target_rank": e["rank"], "record_id": e["record_id"],
                             "sha256": e["sha256"],
                             "duplicate_of_local": local_refs[e["sha256"]]})
            continue
        take(e, "original_target")

    for e in [p for p in pool if p["rank"] > N_TARGETS and not p.get("download_error")]:
        if len(final_targets) >= N_TARGETS:
            break
        if e["sha256"] in seen or e["sha256"] in local_refs:
            replaced.append({"alternate_rank": e["rank"], "record_id": e["record_id"],
                             "sha256": e["sha256"],
                             "duplicate_of": seen.get(e["sha256"],
                                                      local_refs.get(e["sha256"])),
                             "skipped": True})
            continue
        take(e, "replacement_alternate")

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "kimi-code S1 (026_PLAN)",
        "source_candidates": str(CANDIDATES),
        "approval": cand.get("approval"),
        "image_dir": str(OUT_DIR),
        "final_target_count": len(final_targets),
        "final_targets": final_targets,
        "content_duplicates": replaced,
        "download_errors": [p["record_id"] for p in pool if p.get("download_error")],
        "remaining_alternates": [p["rank"] for p in pool
                                 if p["rank"] > N_TARGETS and p["rank"] not in used_ranks
                                 and not p.get("download_error")],
        "local_reference_images": sorted(local_refs.values()),
        "notes": [
            "去重为内容级 SHA-256（候选池内部 + 与本地已有发那科/德马格样图比对）；"
            "非温度页/无法建立真值项待 VLM 预标注阶段判定后按候补固定顺序替换",
            "家族构成：FANUC（Z032/A09）+ DEMAG（Z002/A01、Z005/A02）",
        ],
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"\nfinal targets: {len(final_targets)}/{N_TARGETS}, duplicates replaced/skipped: {len(replaced)}")
    print(f"manifest -> {MANIFEST}")


if __name__ == "__main__":
    main()
