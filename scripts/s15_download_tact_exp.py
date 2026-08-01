"""031_PLAN S1：按获批 TACT 扩样候选下载附件 + SHA-256 去重。

克隆 s4_download_fanuc_demag.py。候选 output/tact_exp_candidates.json（APPROVED），
18 目标 + 12 候补 → docs/samples_tact_exp/，manifest → output/tact_exp_sample_manifest.json。
本地排重参照：docs/samples_tact/（Z022 既有 6 真值图）+ samples_v2 日精图 + S1 校准集日精图。

用法：python3 scripts/s15_download_tact_exp.py
"""
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE = "tbl5KKYuANqGpycE"
CANDIDATES = Path("output/tact_exp_candidates.json")
OUT_DIR = Path("docs/samples_tact_exp")
MANIFEST = Path("output/tact_exp_sample_manifest.json")
N_TARGETS = 18

LOCAL_REFERENCE_GLOBS = [
    "docs/samples_tact/*.jpeg", "docs/samples_tact/*.jpg", "docs/samples_tact/*.png",
    "docs/samples_v2/日精_*.jpeg", "docs/samples_v2/日精_*.jpg", "docs/samples_v2/日精_*.png",
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


def local_name(e):
    date = (e.get("date") or "unknown").replace("-", "")
    return f"tact_{e['machine']}_{date}_rank{e['rank']:02d}_{e['record_id']}.jpeg"


def local_reference_hashes():
    refs = {}
    for pat in LOCAL_REFERENCE_GLOBS:
        for p in sorted(Path(".").glob(pat)):
            refs.setdefault(sha256_of(p), str(p))
    cal = Path("output/calibration_set_s1.json")
    if cal.exists():
        for item in json.loads(cal.read_text()).get("images", []):
            p = Path(item.get("path", ""))
            if p.exists() and "日精" in p.name:
                refs.setdefault(sha256_of(p), str(p))
    return refs


def main():
    cand = json.loads(CANDIDATES.read_text())
    if cand.get("status") != "APPROVED":
        sys.exit(f"候选清单状态 {cand.get('status')}，未批准，禁止下载")
    entries = cand["targets"] + cand["alternates"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    local_refs = local_reference_hashes()
    print(f"local reference images: {len(local_refs)}")

    pool = []
    for e in entries:
        name = local_name(e)
        path = OUT_DIR / name
        if not path.exists() or path.stat().st_size == 0:
            print(f"download rank{e['rank']:02d} {e['machine']} {e['date']} ...")
            if not download(e["attachment"]["file_token"], path):
                pool.append({**e, "local_name": None, "download_error": True})
                continue
        item = {**e, "local_name": name, "sha256": sha256_of(path),
                "size_matches_metadata": path.stat().st_size == e["attachment"].get("size")}
        pool.append(item)

    seen, final_targets, replaced, used_ranks = {}, [], [], set()

    def take(entry, role):
        seen.setdefault(entry["sha256"], f"rank{entry['rank']}")
        used_ranks.add(entry["rank"])
        final_targets.append({"rank": entry["rank"], "role": role, **entry})

    for e in [p for p in pool if p["rank"] <= N_TARGETS and not p.get("download_error")]:
        if e["sha256"] in seen or e["sha256"] in local_refs:
            replaced.append({"target_rank": e["rank"], "sha256": e["sha256"],
                             "duplicate_of": seen.get(e["sha256"], local_refs.get(e["sha256"]))})
            continue
        take(e, "original_target")
    for e in [p for p in pool if p["rank"] > N_TARGETS and not p.get("download_error")]:
        if len(final_targets) >= N_TARGETS:
            break
        if e["sha256"] in seen or e["sha256"] in local_refs:
            continue
        take(e, "replacement_alternate")

    MANIFEST.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "kimi-code S1 (031_PLAN)",
        "final_target_count": len(final_targets),
        "final_targets": final_targets,
        "content_duplicates": replaced,
        "download_errors": [p["record_id"] for p in pool if p.get("download_error")],
        "local_reference_images": sorted(local_refs.values()),
    }, ensure_ascii=False, indent=2))
    print(f"\nfinal targets: {len(final_targets)}/{N_TARGETS}, dups: {len(replaced)}")
    print(f"manifest -> {MANIFEST}")


if __name__ == "__main__":
    main()
