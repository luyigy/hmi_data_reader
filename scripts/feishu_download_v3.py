"""从飞书工艺参数点检 Base 补下载样本，覆盖每个品牌。

与 feishu_download.py（samples_v2）的差异：
- 全程走 raw API（lark-cli api），typed shortcut 会被细粒度 scope 挡（见 skill lark-base-raw-api）。
- 按品牌分组选 record：每个品牌最多 --per-brand 条（默认 3 条），品牌内按记录顺序取前 N 条。
- 同一 file_token 只下载一次（点检表大量跨记录重复附件），重复只记 manifest。
- rec 编号从 100 起，避免与 samples_v2 的 rec00–rec21 撞前缀。

用法：
    python3 scripts/feishu_download_v3.py [--per-brand 3] [--out docs/samples_v3]
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

BASE = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
TABLE = "tbl1ACm7qNrrKsPc"

TEXT_FIELDS = ["品牌", "客户", "模具SAP索引", "日期", "位置编号", "注塑机ID"]
ATTACHMENT_FIELDS = {
    "成型条件-炮筒温度设定": "炮筒",
    "成型条件-射出/保压": "射出",
    "成型条件-储料/冷却": "储料",
    "成型条件-成型监控一/二": "监控",
    "成型条件-波形图": "波形",
    "工艺参数图片": "工艺",
}


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
        raise RuntimeError(f"{method} {path} failed: {res.stderr or res.stdout}")
    return json.loads(res.stdout)


def list_all_records():
    records, page_token = [], None
    while True:
        params = {"page_size": 200}
        if page_token:
            params["page_token"] = page_token
        d = api("GET", f"/open-apis/bitable/v1/apps/{BASE}/tables/{TABLE}/records", params=params)
        data = d["data"]
        records.extend(data.get("items", []))
        if not data.get("has_more"):
            return records
        page_token = data["page_token"]


def first_or_none(v):
    if isinstance(v, list):
        return v[0] if v else None
    return v


def text_of(v):
    """多选/单选/人员/文本统一取可读字符串。"""
    v = first_or_none(v)
    if v is None:
        return None
    if isinstance(v, dict):
        return v.get("text") or v.get("name")
    if isinstance(v, list):  # 富文本段
        return "".join(seg.get("text", "") for seg in v if isinstance(seg, dict)) or None
    return str(v)


def safe(s):
    if s is None:
        return "X"
    s = str(s).replace("/", "_").replace("\\", "_").replace(" ", "_")
    s = "".join(c for c in s if ord(c) < 128 or 0x4E00 <= ord(c) <= 0x9FFF)
    return s[:40]


def download_attachment(file_token, out_path: Path):
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-brand", type=int, default=3)
    ap.add_argument("--out", default="docs/samples_v3")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    records = list_all_records()
    print(f"records total: {len(records)}")

    # 按品牌分组，每品牌取前 N 条
    by_brand = {}
    for rec in records:
        brand = safe(text_of(rec["fields"].get("品牌")))
        by_brand.setdefault(brand, []).append(rec)
    selected = []
    for brand, recs in sorted(by_brand.items()):
        selected.extend((brand, r) for r in recs[: args.per_brand])
        print(f"  {brand}: {len(recs)} records, take {min(len(recs), args.per_brand)}")

    stats = {"downloaded": 0, "dedup_skipped": 0, "errors": 0}
    manifest, seen_tokens = [], {}

    for i, (brand, rec) in enumerate(selected):
        f = rec["fields"]
        loc = safe(text_of(f.get("位置编号")))
        mold = safe(text_of(f.get("模具SAP索引")))
        date = str(f.get("日期") or "?")[:10].replace("-", "")
        machine = safe(text_of(f.get("注塑机ID")))
        prefix = f"{brand}_{machine}_{loc}_{mold}_{date}_rec{100 + i}"

        for fld_name, fld_short in ATTACHMENT_FIELDS.items():
            att = f.get(fld_name)
            if not isinstance(att, list):
                continue
            for j, info in enumerate(att):
                token = info.get("file_token")
                if not token:
                    continue
                if token in seen_tokens:
                    stats["dedup_skipped"] += 1
                    manifest.append({"record_idx": 100 + i, "field": fld_name,
                                     "file_token": token, "duplicate_of": seen_tokens[token]})
                    continue
                ext = Path(info.get("name", "x.jpeg")).suffix or ".jpeg"
                local = out_dir / f"{prefix}_{fld_short}_{j:02d}{ext}"
                if local.exists() and local.stat().st_size > 0:
                    seen_tokens[token] = local.name
                    stats["downloaded"] += 1
                    continue
                if download_attachment(token, local):
                    seen_tokens[token] = local.name
                    stats["downloaded"] += 1
                    manifest.append({"record_id": rec["record_id"], "record_idx": 100 + i,
                                     "brand": brand, "machine": machine, "loc": loc,
                                     "mold": mold, "date": date, "field": fld_name,
                                     "file_token": token, "local_name": local.name,
                                     "size": local.stat().st_size})
                    print(f"  ok {local.name}")
                else:
                    stats["errors"] += 1

    print(f"\n=== 下载统计 ===\n成功: {stats['downloaded']}\n重复附件跳过: {stats['dedup_skipped']}\n失败: {stats['errors']}")
    mp = out_dir / "_manifest.json"
    mp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"manifest -> {mp}")


if __name__ == "__main__":
    main()
