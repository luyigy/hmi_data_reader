"""Run without GPU: /data/venvs/hmi-unsloth/bin/python -m tests.check_finetuned_service."""
import io
from fastapi.testclient import TestClient
from PIL import Image
from scripts import serve_finetuned as service

client = TestClient(service.app)
assert client.get('/').status_code == 200
assert client.get('/health').json()['ready'] is False
assert client.post('/infer', content=b'not an image').status_code == 422
assert client.post('/infer', content=b'x', headers={'Origin': 'https://example.com'}).status_code == 403
service.MAX_BYTES = 8
assert client.post('/infer', content=b'x' * 9).status_code == 413
service.MAX_BYTES = 20 * 1024 * 1024
picture = io.BytesIO()
Image.new('RGB', (16, 16)).save(picture, format='PNG')
assert client.post('/infer', content=picture.getvalue()).status_code == 503
service.model = object()
with service.lock:
    assert client.post('/infer', content=picture.getvalue()).status_code == 429
service.model = None
print('PASS: page, health, invalid image, origin, upload limit, readiness, GPU busy')
