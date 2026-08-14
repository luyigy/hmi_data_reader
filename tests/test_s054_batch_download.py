import json
import tempfile
import unittest
from pathlib import Path

from scripts.s054_batch_download import load_checkpoint_hashes, load_checkpoint_pairs


class CheckpointExclusionTest(unittest.TestCase):
    def test_loads_selected_record_field_pairs(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "checkpoint.json"
            path.write_text(json.dumps({"entries": [
                {"record_id": "rec1", "field": "炮筒", "status": "kept", "sha256": "hash1"},
                {"record_id": "rec2", "field": "炮筒", "status": "duplicate_known", "sha256": "hash2"},
            ]}))
            self.assertEqual(load_checkpoint_pairs([path]), {
                ("rec1", "炮筒"), ("rec2", "炮筒"),
            })
            self.assertEqual(load_checkpoint_hashes([path]), {"hash1", "hash2"})


if __name__ == "__main__":
    unittest.main()
