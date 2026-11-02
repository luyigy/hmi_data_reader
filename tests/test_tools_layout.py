"""Tool relocation must preserve actual CLI entry points and directory navigation."""
from pathlib import Path
import re
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_each_source_directory_has_a_readme():
    directories = {p.parent for p in (ROOT/'scripts').rglob('*.py') if '__pycache__' not in p.parts}
    assert not [str(p.relative_to(ROOT)) for p in directories if not (p/'README.md').is_file()]
    assert not [p.name for p in (ROOT/'scripts').glob('*.py') if re.match(r'^_?s\d', p.stem)]


@pytest.mark.parametrize('tool', [
    'data_tools/download_images_batch.py', 'data_tools/feishu_source.py',
    'data_tools/datasets.py', 'evaluation/recognize_batch.py',
    'evaluation/verify_accuracy.py', 'evaluation/vlm_text_eval.py',
    'diagnostics/explain_case.py', 'integrations/feishu_card_assistant.py',
    'operations/manage_page_templates.py', 'operations/profile_lifecycle.py',
    'operations/run_pipeline.py', 'training/train_small_sample.py',
])
def test_tool_help_works_outside_the_repository(tool, tmp_path):
    # Help must not start OCR, contact Feishu, publish templates or train a model.
    result = subprocess.run([sys.executable, str(ROOT/'scripts'/tool), '--help'],
                            cwd=tmp_path, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert 'usage:' in result.stdout.lower()


def test_batch_recognition_uses_selected_endpoint_without_network(tmp_path, monkeypatch):
    import json
    from scripts.evaluation.recognize_batch import recognize
    image = tmp_path/'screen.png'
    image.write_bytes(b'isolated-fixture')
    requests = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self): return json.dumps({'profile_id': 'selected'}).encode()
    def open_request(request, **kwargs):
        requests.append(request)
        return Response()
    monkeypatch.setattr('urllib.request.urlopen', open_request)
    assert recognize(image, 'http://isolated-reader/api/v1/recognize') == {'profile_id': 'selected'}
    assert requests[0].full_url == 'http://isolated-reader/api/v1/recognize'
    assert b'isolated-fixture' in requests[0].data
