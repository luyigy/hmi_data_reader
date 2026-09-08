"""Trusted Web identity must isolate every lab operation, including legacy data."""
import io
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image

from validation_lab.app import create_app


def test_proxy_identity_and_all_session_operations(tmp_path, monkeypatch):
    monkeypatch.setenv('HMI_LAB_PROXY_KEY', 'test-proxy-key')

    async def reader(data, filename):
        return {'fields': {}, 'status': 'rejected'}

    app = create_app(tmp_path, reader=reader, password='standalone-password')
    alice = {'Authorization': 'Bearer test-proxy-key', 'X-HMI-User': str(uuid4())}
    bob = {**alice, 'X-HMI-User': str(uuid4())}
    with TestClient(app) as client:
        assert client.get('/api/config', headers={'X-HMI-User': alice['X-HMI-User']}).status_code == 401
        assert client.get('/api/config', headers={**alice, 'X-HMI-User': '../escape'}).status_code == 401
        assert client.get('/api/config', headers={**alice, 'Authorization': 'Bearer wrong'}).status_code == 401
        legacy = client.post('/api/sessions', auth=('lab', 'standalone-password')).json()['session']['id']
        assert client.get('/api/sessions', headers=alice).json() == []
        assert client.get('/api/sessions/' + legacy, headers=alice).status_code == 404
        data = client.post('/api/sessions', headers=alice).json()
        sid = data['session']['id']
        image = io.BytesIO()
        Image.new('RGB', (4, 4)).save(image, 'PNG')
        uploaded = client.post(f'/api/sessions/{sid}/images', headers=alice,
                               files={'file': ('test.png', image.getvalue(), 'image/png')})
        assert uploaded.status_code == 200
        session = uploaded.json()['session']
        iid = session['images'][0]['id']
        review = {'expected_revision': session['revision'], 'target': session['target']}
        assert client.get('/api/sessions', headers=bob).json() == []
        for method, suffix, kwargs in [
            ('GET', '', {}), ('GET', '/export?bundle=true', {}),
            ('GET', f'/images/{iid}', {}), ('POST', f'/images/{iid}/recognize', {}),
            ('PUT', '/review', {'json': review}),
            ('POST', '/images', {'files': {'file': ('test.png', image.getvalue(), 'image/png')}}),
        ]:
            assert client.request(method, f'/api/sessions/{sid}' + suffix, headers=bob, **kwargs).status_code == 404
        assert client.put(f'/api/sessions/{sid}/review', headers=alice, json=review).status_code == 200
        assert client.get(f'/api/sessions/{sid}/images/{iid}', headers=alice).content == image.getvalue()
        assert client.get(f'/api/sessions/{sid}/export?bundle=true', headers=alice).content.startswith(b'PK')
        assert client.get('/api/config', headers=alice).json()['storage_namespace'] == alice['X-HMI-User']
        assert len(client.get('/api/sessions', auth=('lab', 'standalone-password')).json()) == 1
        html = client.get('/', headers=alice)
        assert "frame-ancestors 'self'" in html.headers['content-security-policy']
        assert 'src="lab.js"' in html.text
    with TestClient(create_app(tmp_path, password='standalone-password')) as client:
        assert client.get('/api/sessions/' + sid, headers=alice).status_code == 200
