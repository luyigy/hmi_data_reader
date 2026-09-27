"""Offline regression: confirmed labels must not override held-out image hashes."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts import train_small_sample as training

rows = training.read_samples()
assert rows and all(r["id"] != "bde2ce6c4a7e75f3" for r in rows)
original = training.RESERVED
try:
    with TemporaryDirectory() as folder:
        training.RESERVED = Path(folder) / "reserved.json"
        reserved = json.loads(original.read_text())
        reserved.append({"image_sha256": rows[0]["image_sha256"]})
        training.RESERVED.write_text(json.dumps(reserved))
        filtered = training.read_samples()
        assert [r["id"] for r in filtered] == [r["id"] for r in rows[1:]]
finally:
    training.RESERVED = original
print("PASS: confirmed samples exclude held-out hashes")
