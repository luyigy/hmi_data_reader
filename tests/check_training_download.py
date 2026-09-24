"""Offline smoke check: python tests/check_training_download.py (no model downloads)."""
import runpy
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import patch

script = Path(__file__).resolve().parents[1] / 'scripts/download_training_model.py'
files = [{'Type': 'blob', 'Path': 'model.safetensors', 'Size': 3,
          'Sha256': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'}]
api = types.ModuleType('modelscope.hub.api')
api.HubApi = lambda: types.SimpleNamespace(get_model_files=lambda *a, **k: files)
sdk = types.ModuleType('modelscope')

with tempfile.TemporaryDirectory() as temp:
    dest = Path(temp) / 'model'
    sdk.snapshot_download = lambda *a, **k: (dest / 'model.safetensors').write_bytes(b'abc')
    with patch.dict(sys.modules, {'modelscope': sdk, 'modelscope.hub.api': api}):
        with patch.object(sys, 'argv', [str(script), '--local-dir', str(dest), '--check']):
            try:
                runpy.run_path(str(script), run_name='__main__')
            except SystemExit as exc:
                assert exc.code == 0
        assert not dest.exists(), '--check must not create files'
        with patch.object(sys, 'argv', [str(script), '--local-dir', str(dest)]):
            runpy.run_path(str(script), run_name='__main__')
            assert 'complete' in (dest / 'download-status.json').read_text()
            sdk.snapshot_download = lambda *a, **k: (dest / 'model.safetensors').write_bytes(b'xyz')
            try:
                runpy.run_path(str(script), run_name='__main__')
            except OSError:
                pass
            else:
                raise AssertionError('Wrong checksum with correct file size must fail')
            assert 'failed' in (dest / 'download-status.json').read_text()
print('download checks passed')
