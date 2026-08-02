"""049_PLAN 阶段A A3：射出/保压 B_AND_R 波次 Z050 单机候选（6目标+2候补）+ 下载去重。

候选：大表只读 search（品牌=日精、Z022、含「成型条件-射出/保压」附件），同字节数去重，
random.Random(SEED) shuffle。049 全自动接力：选机自动（队列固化 050），无需逐单元批准。

用法：python3 scripts/s21_inj_z036_candidates_download.py
"""
import hashlib
import json
import random
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE = "tbl5KKYuANqGpycE"
ATTACH_FIELD = "成型条件-射出/保压"
MACHINE, BRAND, FAMILY = "Z050", "伯乐", "B_AND_R"
SEED = 20260802
TARGETS, ALTERNATES = 6, 2
TZ_CN = timezone(timedelta(hours=8))
CAND_OUT = Path("output/inj_z050_candidates.json")
OUT_DIR = Path("docs/samples_inj_z050")
MANIFEST = Path("output/inj_z050_sample_manifest.json")


def api(method, path, **kwargs):
    cmd = ["lark-cli", "api", method, path, "--as", "bot"]
    if "params" in kwargs:
        cmd += ["--params", json.dumps(kwargs["params"], ensure_ascii=False)]
    if "data" in kwargs:
        cmd += ["--data", json.dumps(kwargs["data"], ensure_ascii=False)]
    if "output" in kwargs:
        cmd += ["-o", kwargs["output"]]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"{method} {path} failed: {res.stderr or res.stdout[:2000]}")
    if "output" in kwargs:
        return None
    return json.loads(res.stdout)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


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


def main():
    body = {
        "field_names": ["品牌", "注塑机ID", "位置编号", "日期", ATTACH_FIELD],
        "filter": {"conjunction": "and", "conditions": [
            {"field_name": "品牌", "operator": "contains", "value": [BRAND]},
            {"field_name": "注塑机ID", "operator": "is", "value": [MACHINE]}]},
    }
    items = api("POST", f"/open-apis/bitable/v1/apps/{BASE}/tables/{TABLE}/records/search",
                params={"page_size": 500}, data=body)["data"]["items"]
    pool = []
    by_size = defaultdict(list)
    for it in items:
        f = it["fields"]
        atts = f.get(ATTACH_FIELD) or []
        if not atts:
            continue
        d = f.get("日期")
        date = (datetime.fromtimestamp(d / 1000, tz=TZ_CN).strftime("%Y-%m-%d")
                if isinstance(d, (int, float)) else "unknown")
        by_size[atts[0].get("size")].append({
            "record_id": it["record_id"], "date": date,
            "file_token": atts[0].get("file_token"), "size": atts[0].get("size")})
    for size, group in by_size.items():
        group.sort(key=lambda r: (r["date"], r["record_id"]))
        pool.append(group[0])
    pool.sort(key=lambda r: (r["date"], r["record_id"]))
    random.Random(SEED).shuffle(pool)
    targets, alternates = pool[:TARGETS], pool[TARGETS:TARGETS + ALTERNATES]
    print(f"附件 {sum(len(v) for v in by_size.values())} 去重后 {len(pool)}；目标 {len(targets)} 候补 {len(alternates)}")

    CAND_OUT.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "kimi-code S2 (035_PLAN)",
        "status": "APPROVED",
        "approval": {"approved_by": "用户 2026-08-01「拆散小点」指示", "note": "第一波 Z022 单机 6+2"},
        "selection_spec": {"random_seed": SEED, "pool": f"{BRAND} {MACHINE} 含{ATTACH_FIELD}附件",
                           "cap": "6 目标 + 2 候补（用户小批指示）"},
        "targets": [{"rank": i + 1, "machine": MACHINE, "brand": BRAND, "family": FAMILY, **e}
                    for i, e in enumerate(targets)],
        "alternates": [{"rank": TARGETS + i + 1, "machine": MACHINE, "brand": BRAND,
                        "family": FAMILY, **e} for i, e in enumerate(alternates)],
    }, ensure_ascii=False, indent=2))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    final, dups, seen = [], [], set()
    for i, e in enumerate(targets + alternates):
        rank = i + 1
        name = f"inj_{MACHINE}_{e['date'].replace('-', '')}_rank{rank:02d}_{e['record_id']}.jpeg"
        path = OUT_DIR / name
        if rank <= TARGETS:
            print(f"download rank{rank:02d} {e['date']} ...")
            if not download(e["file_token"], path):
                continue
            h = sha256_of(path)
            if h in seen:
                dups.append({"rank": rank, "sha256": h})
                continue
            seen.add(h)
            final.append({"rank": rank, "role": "original_target", "machine": MACHINE,
                          "brand": BRAND, "family": FAMILY, "local_name": name,
                          "sha256": h, **e})
    for e in alternates:
        if len(final) >= TARGETS:
            break
        rank = targets.index(e) + TARGETS + 1 if e in targets else None
        name = f"inj_{MACHINE}_{e['date'].replace('-', '')}_rank99_{e['record_id']}.jpeg"
        path = OUT_DIR / name
        if not download(e["file_token"], path):
            continue
        h = sha256_of(path)
        if h in seen:
            continue
        seen.add(h)
        final.append({"rank": len(final) + 1, "role": "replacement_alternate",
                      "machine": MACHINE, "brand": BRAND, "family": FAMILY,
                      "local_name": name, "sha256": h, **e})

    MANIFEST.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "kimi-code S3 (035_PLAN)",
        "final_target_count": len(final), "final_targets": final,
        "content_duplicates": dups,
    }, ensure_ascii=False, indent=2))
    print(f"final targets: {len(final)}/{TARGETS}, dups: {len(dups)} -> {MANIFEST}")


if __name__ == "__main__":
    sys.exit(main())
