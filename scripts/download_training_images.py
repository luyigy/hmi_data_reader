"""Download a bounded Feishu candidate batch; never approve or split samples.

Run from repository root: python3 -m scripts.download_training_images
Uses the existing bot/raw API reader (typed record API lacks base:record:read).
The saved selection is immutable on resume; completed entries are revalidated.
"""
import hashlib
import json
import subprocess
import urllib.parse
import urllib.request
from collections import Counter, defaultdict, deque
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from PIL import Image

from scripts.feishu_download_v3 import BASE, api, text_of

TABLE = "tbl5KKYuANqGpycE"
BATCH = Path("datasets/hmi/raw/feishu/20260927")
FIELDS = {"成型条件-射出/保压": "injection-holding", "成型条件-储料/冷却": "metering-cooling"}
BATCH.mkdir(parents=True, exist_ok=True)
selection_file = BATCH / "selection.json"
manifest_file = BATCH / "manifest.json"
selection = []
if selection_file.exists():
    selection = json.loads(selection_file.read_text())
else:
    result = subprocess.run([
        "lark-cli", "base", "+field-list", "--base-token", BASE,
        "--table-id", TABLE, "--as", "bot", "--json",
    ], check=True, capture_output=True, text=True)
    (BATCH / "source-fields.json").write_text(result.stdout)
    fields = json.loads(result.stdout)["data"]["fields"]
    brands = next(f["options"] for f in fields if f["name"] == "品牌")
    for option in brands:
        brand = option["name"]
        if brand == "伊之密":
            continue
        request = {
            "field_names": ["品牌", "注塑机ID", "模具SAP索引", "日期", *FIELDS],
            "filter": {"conjunction": "and", "conditions": [
                {"field_name": "品牌", "operator": "contains", "value": [brand]}
            ]},
            "sort": [{"field_name": "日期", "desc": True}],
        }
        response = api("POST", f"/open-apis/bitable/v1/apps/{BASE}/tables/{TABLE}/records/search",
                       params={"page_size": 160}, data=request)
        assert response.get("ok") is not False, response
        data = response["data"]
        (BATCH / f"{brand}-query.json").write_text(json.dumps(
            {"request": request, "page_size": 160, "response": response}, ensure_ascii=False, indent=2))
        groups = defaultdict(deque)
        for record in data.get("items", []):
            f = record["fields"]
            machine = text_of(f.get("注塑机ID"))
            if not machine:
                continue
            mold = text_of(f.get("模具SAP索引"))
            date = datetime.fromtimestamp(f["日期"] / 1000, ZoneInfo("Asia/Shanghai")).isoformat()
            for field, page in FIELDS.items():
                for slot, attachment in enumerate(f.get(field) or []):
                    if not attachment.get("type", "").startswith("image/"):
                        continue
                    groups[(machine, mold)].append({
                        "brand": brand, "machine": machine, "mold": mold, "date": date,
                        "record_id": record["record_id"], "base_token": BASE, "table_id": TABLE,
                        "field": field, "page": page, "slot": slot, "attachment": attachment,
                        "group_machine": f"{BASE}/{TABLE}/{machine}",
                        "split": None, "annotation_status": "unreviewed", "near_duplicate_status": "pending",
                    })
        # ponytail: round-robin only within latest 160 records/brand; query older dates if coverage is missing.
        queues = list(groups.values())
        seen = set()
        chosen = []
        while queues and len(chosen) < 35:
            for queue in queues:
                row = queue.popleft()
                token = row["attachment"]["file_token"]
                if token not in seen:
                    seen.add(token)
                    chosen.append(row)
                    if len(chosen) == 35:
                        break
            queues = [q for q in queues if q]
        selection.extend(chosen)
        print(brand, "selected", len(chosen), "query_has_more", data.get("has_more"), flush=True)
    selection_file.write_text(json.dumps(selection, ensure_ascii=False, indent=2))

# Hash only original collections / annotation images, not rendered overlays and crops.
existing = {}
for pattern in ["docs/*sample*/**/*", "output/training-prep/annotation*/**/image.*",
                "output/training-prep/nissei*/**/image.*", "output/inference-tests/batch-20260926-feishu/*"]:
    for path in Path(".").glob(pattern):
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
            existing.setdefault(hashlib.sha256(path.read_bytes()).hexdigest(), str(path))
known_tokens = {}
for row in json.loads(Path("output/inference-tests/batch-20260926-feishu/manifest.json").read_text()):
    path = Path(row["path"])
    if path.exists():
        known_tokens[row["attachment"]["file_token"]] = path
completed = json.loads(manifest_file.read_text()) if manifest_file.exists() else []
by_token = {r["attachment"]["file_token"]: r for r in completed}
errors = []
for row in selection:
    token = row["attachment"]["file_token"]
    if token in by_token:
        prior = by_token[token]
        assert hashlib.sha256(Path(prior["path"]).read_bytes()).hexdigest() == prior["sha256"]
        continue
    try:
        path = known_tokens.get(token)
        downloaded = path is None
        if downloaded:
            extra = urllib.parse.parse_qs(urllib.parse.urlsplit(row["attachment"]["url"]).query)["extra"][0]
            result = api("GET", "/open-apis/drive/v1/medias/batch_get_tmp_download_url",
                         params={"file_tokens": token, "extra": extra})
            url = result["data"]["tmp_download_urls"][0]["tmp_download_url"]
            with urllib.request.urlopen(url, timeout=90) as response:
                payload = response.read()
            assert len(payload) == row["attachment"]["size"], "attachment size mismatch"
            folder = BATCH / row["brand"] / row["machine"]
            assert folder.resolve().is_relative_to(BATCH.resolve()), "unsafe source path"
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / f'{row["date"][:10]}_{row["record_id"]}_{row["page"]}_{row["slot"]}.jpg'
            path = path.with_suffix(".part")
            path.write_bytes(payload)
        with Image.open(path) as im:
            im.load()
            width, height = im.size
            image_format = im.format
            pixel_sha = hashlib.sha256(im.convert("RGB").tobytes() + str(im.size).encode()).hexdigest()
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        reused = existing.get(digest)
        if downloaded and reused:
            path.unlink()
            path = Path(reused)
        elif downloaded:
            extension = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}.get(image_format)
            assert extension, f"unsupported image format {image_format}"
            final = path.with_suffix(extension)
            if final.exists():
                assert hashlib.sha256(final.read_bytes()).hexdigest() == digest, f"refusing to overwrite {final}"
                path.unlink()
            else:
                path.rename(final)
            path = final
        existing.setdefault(digest, str(path))
        entry = dict(row, path=str(path), sha256=digest, pixel_sha256=pixel_sha,
                     width=width, height=height, bytes=path.stat().st_size,
                     acquisition="downloaded" if downloaded and not reused else "reused_local")
        completed.append(entry)
        by_token[token] = entry
        temp = manifest_file.with_suffix(".tmp")
        temp.write_text(json.dumps(completed, ensure_ascii=False, indent=2))
        temp.replace(manifest_file)
        print(len(completed), row["brand"], row["machine"], entry["acquisition"], flush=True)
    except Exception as exc:
        errors.append({"file_token": token, "record_id": row["record_id"], "error": str(exc)})
        print("FAILED", row["record_id"], type(exc).__name__, flush=True)

summary = {"selected": len(selection), "completed": len(completed), "errors": errors,
           "by_brand": dict(Counter(r["brand"] for r in completed)),
           "by_acquisition": dict(Counter(r["acquisition"] for r in completed)),
           "machines": len({r["group_machine"] for r in completed}),
           "unique_sha256": len({r["sha256"] for r in completed}),
           "unique_pixels": len({r["pixel_sha256"] for r in completed}),
           "note": "Candidates only; latest 160 records/brand, max 35 attachments/brand. Not a full-table inventory."}
(BATCH / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
assert all(r["split"] is None and r["annotation_status"] == "unreviewed" for r in completed)
assert len(by_token) == len(completed)
assert not errors, f"{len(errors)} downloads failed; see summary.json and resume"
assert len(completed) == len(selection)
print(json.dumps(summary, ensure_ascii=False), flush=True)
