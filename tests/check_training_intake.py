"""Offline checks for the downloaded batch and hash-preserving relocation.

Run from repository root: python3 -m tests.check_training_intake
Requires the local dataset assets; does not call Feishu or load a model.
"""
import hashlib
import json
from pathlib import Path

from PIL import Image

batch = Path("datasets/hmi/raw/feishu/20260927")
rows = json.loads((batch / "manifest.json").read_text())
selection = json.loads((batch / "selection.json").read_text())
assert {r["attachment"]["file_token"] for r in rows} == {
    r["attachment"]["file_token"] for r in selection
}
assert len(rows) == len({r["attachment"]["file_token"] for r in rows})
for row in rows:
    path = Path(row["path"])
    assert row["brand"] != "伊之密"
    assert row["split"] is None and row["annotation_status"] == "unreviewed"
    assert row["near_duplicate_status"] == "pending"
    assert row["machine"] and row["record_id"] and row["attachment"]["file_token"]
    assert path.stat().st_size == row["bytes"] == row["attachment"]["size"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == row["sha256"], path
    with Image.open(path) as image:
        image.load()
        assert image.size == (row["width"], row["height"])
        assert hashlib.sha256(image.convert("RGB").tobytes() + str(image.size).encode()).hexdigest() == row["pixel_sha256"]

ledger = json.loads(Path("output/organization-20260927/migration.json").read_text())
verified = 0
for entry in ledger:
    source, target = Path(entry["source"]), Path(entry["target"])
    assert source.is_symlink() and source.resolve() == target.resolve()
    for item in entry["files"]:
        path = target / item["relative"] if target.is_dir() else target
        assert path.stat().st_size == item["bytes"], path
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"], path
        verified += 1
print(f"PASS: {len(rows)} attachments decoded and verified; {verified} relocated files unchanged")
