"""Run: .venv/bin/python -m validation_lab.app (independent of the GPU process)."""
import argparse
import asyncio
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask

from .mapping import CATALOG, FIXTURE, MAPPING_VERSION, REGISTRY, ROOT, preview, validate_target

HERE = Path(__file__).parent
MAX_IMAGE = 20 * 1024 * 1024
MAX_IMAGES = 30


class Review(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_revision: int = Field(ge=0)
    target: dict | None = None
    edits: dict = Field(default_factory=dict)
    images: dict = Field(default_factory=dict)
    drafts: dict = Field(default_factory=dict)
    note: str = Field(default='', max_length=4000)


def now():
    return datetime.now(timezone.utc).isoformat()


def source_version():
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True)
    files = ['hmi_service.py', 'scripts/extract_fields.py', 'scripts/contract.py', 'scripts/vlm_qwen.py',
             'validation_lab/mapping.py', 'validation_lab/app.py', 'validation_lab/lab.js']
    return {'commit': result.stdout.strip(), 'files_sha256': {
        f: hashlib.sha256((ROOT / f).read_bytes()).hexdigest() for f in files}}


def validate_draft(result):
    """Check the storage boundary without filtering unknown candidate metadata."""
    if (not isinstance(result, dict) or not isinstance(result.get('sections'), list)
            or not isinstance(result.get('questions'), list)
            or any(not isinstance(q, str) for q in result['questions'])):
        raise ValueError('候选必须包含 sections/questions')
    json.dumps(result, allow_nan=False)
    for section in result['sections']:
        if (not isinstance(section, dict) or not isinstance(section.get('label'), str)
                or not isinstance(section.get('fields'), list)):
            raise ValueError('候选分区不合法')
        for field in section['fields']:
            if (not isinstance(field, dict) or not isinstance(field.get('screen_label'), str)
                    or not isinstance(field.get('items'), list) or not field['items']):
                raise ValueError('候选字段不合法')
            for item in field['items']:
                if (not isinstance(item, dict) or 'value' not in item
                        or (item['value'] is not None and type(item['value']) not in (int, float))):
                    raise ValueError('候选数值不合法')


def latest_result(image):
    """Use the last success, retaining its original 1-based attempt identity."""
    return next(((i, attempt['result']) for i, attempt in
                 reversed(list(enumerate(image['attempts'], 1)))
                 if 'result' in attempt and 'error' not in attempt), (0, None))


async def recognize(data, filename):
    url = os.getenv('HMI_READER_URL', 'http://127.0.0.1:8765').rstrip('/')
    key = os.getenv('HMI_API_KEY', '')
    headers = {'Authorization': f'Bearer {key}'} if key else {}
    try:
        async with httpx.AsyncClient(timeout=180, trust_env=False, follow_redirects=False) as client:
            async with client.stream('POST', url + '/api/v1/draft', headers=headers,
                                     files={'file': (filename, data, 'application/octet-stream')}) as response:
                if response.status_code != 200:
                    raise HTTPException(502, f'Reader 返回 HTTP {response.status_code}；检查服务就绪状态和服务端鉴权配置')
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > 10 * 1024 * 1024:
                        raise HTTPException(502, 'Reader 响应超过限制')
                result = json.loads(chunks, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                validate_draft(result)
                return result
    except (httpx.HTTPError, ValueError, TypeError, RecursionError):
        raise HTTPException(502, 'Reader 无法连接、超时或返回了非法结果；照片已保留，可重试') from None


def create_app(data_dir=None, reader=None, password=None):
    root = Path(data_dir or os.getenv('HMI_LAB_DATA_DIR', ROOT / 'output/validation_lab'))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    read_image = reader or recognize
    secret = password if password is not None else os.getenv('HMI_LAB_PASSWORD', '')
    proxy_key = os.getenv('HMI_LAB_PROXY_KEY', '')
    owner = ContextVar('lab_owner', default='')
    app = FastAPI(title='HMI 拍照验证台', docs_url=None, redoc_url=None, openapi_url=None)
    # ponytail: single-process local lab; use a transactional store before multiple workers.
    lock = asyncio.Lock()
    gpu_queue = asyncio.Semaphore(1)

    @app.middleware('http')
    async def access(request, call_next):
        identity = request.headers.get('x-hmi-user', '')
        authorization = request.headers.get('authorization', '')
        proxied = bool(identity or authorization.lower().startswith('bearer '))
        if proxied:
            if not proxy_key or not hmac.compare_digest(authorization.encode(), ('Bearer ' + proxy_key).encode()):
                return Response(status_code=401)
            try:
                identity = str(UUID(identity))
            except ValueError:
                return Response(status_code=401)
        host = request.url.hostname
        if not proxied and not secret and host not in ('localhost', '127.0.0.1', '::1', 'testserver'):
            return JSONResponse({'detail': '局域网访问需先设置 HMI_LAB_PASSWORD'}, status_code=403)
        if secret and not proxied:
            import base64
            try:
                scheme, credentials = request.headers.get('authorization', '').split(' ', 1)
                user, supplied = base64.b64decode(credentials, validate=True).decode().split(':', 1)
                valid = scheme.lower() == 'basic' and user == 'lab' and hmac.compare_digest(supplied, secret)
            except (ValueError, UnicodeError):
                valid = False
            if not valid:
                return Response(status_code=401, headers={'WWW-Authenticate': 'Basic realm="HMI Lab", charset="UTF-8"'})
        origin = request.headers.get('origin')
        if request.method not in ('GET', 'HEAD') and origin and origin != str(request.base_url).rstrip('/'):
            return JSONResponse({'detail': '不接受跨站写入'}, status_code=403)
        limit = MAX_IMAGE + 1024 * 1024 if request.url.path.endswith('/images') else 1024 * 1024
        if request.url.path.endswith('/review'):
            limit = 32 * 1024 * 1024  # A full 10 MiB Reader response plus JSON escaping and review metadata.
        total = 0
        receive = request._receive

        async def bounded_receive():
            nonlocal total
            message = await receive()
            total += len(message.get('body', b''))
            if total > limit:
                raise HTTPException(413, '请求过大')
            return message
        request._receive = bounded_receive
        token = owner.set(identity if proxied else '')
        try:
            response = await call_next(request)
        except HTTPException as exc:
            response = JSONResponse({'detail': exc.detail}, status_code=exc.status_code)
        finally:
            owner.reset(token)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'"
        return response

    def storage():
        path = root / 'users' / owner.get() if owner.get() else root
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        return path

    def folder(sid):
        try:
            return storage() / str(UUID(sid))
        except ValueError:
            raise HTTPException(404, '验证批次不存在') from None

    def load(sid):
        try:
            return json.loads((folder(sid) / 'session.json').read_text())
        except FileNotFoundError:
            raise HTTPException(404, '验证批次不存在') from None

    def save(session):
        session['updated_at'] = now()
        path = folder(session['id']) / 'session.json'
        temp = path.with_suffix('.tmp')
        with temp.open('w') as handle:
            json.dump(session, handle, ensure_ascii=False, allow_nan=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        temp.replace(path)

    def response(session):
        legacy = {**session, 'images': []}
        candidates = []
        for image in session['images']:
            attempt, raw = latest_result(image)
            if raw is None:
                continue
            if 'sections' in raw or 'questions' in raw:
                saved = session.get('draft_reviews', {}).get(image['id'])
                candidates.append({'image_id': image['id'], 'attempt': attempt,
                    'result': deepcopy(raw),
                    'review': deepcopy(saved) if saved and saved['attempt'] == attempt else None,
                    'excluded': image.get('excluded', False),
                    'last_error': image['attempts'][-1].get('error'),
                    'mapping_status': 'unmapped', 'notice': '暂不可映射；人工确认不等于业务 safe'})
            else:
                # Preserve legacy row IDs even after a failed retry; never send drafts to fields mapping.
                legacy['images'].append({**image, 'attempts': image['attempts'][:attempt]})
        try:
            report = preview(legacy)
        except (ValueError, KeyError, TypeError, IndexError, AttributeError, RecursionError):
            raise HTTPException(422, '目标结构或识别字段不符合验证结构，请检查参数 JSON') from None
        return {'session': session, 'preview': report, 'candidates': candidates}

    @app.get('/')
    async def index():
        return FileResponse(HERE / 'index.html')

    @app.get('/lab.js')
    async def javascript():
        return FileResponse(HERE / 'lab.js', media_type='text/javascript')

    @app.get('/lab.css')
    async def css():
        return FileResponse(HERE / 'lab.css', media_type='text/css')

    @app.get('/favicon.ico')
    async def favicon():
        return Response(status_code=204)

    @app.get('/api/config')
    async def config():
        return {'fixture': FIXTURE, 'contract_version': CATALOG['contract_version'],
                'mapping_version': MAPPING_VERSION, 'max_images': MAX_IMAGES,
                'storage_namespace': owner.get() or 'standalone'}

    @app.get('/api/sessions')
    async def sessions():
        items = []
        for path in storage().glob('*/session.json'):
            data = json.loads(path.read_text())
            items.append({k: data[k] for k in ('id', 'created_at', 'updated_at')})
        return sorted(items, key=lambda s: s['updated_at'], reverse=True)[:100]

    @app.post('/api/sessions')
    async def new_session():
        async with lock:
            sid = str(uuid4())
            folder(sid).mkdir(mode=0o700)
            session = {'id': sid, 'created_at': now(), 'revision': 0, 'images': [], 'edits': {},
                       'target': FIXTURE['parameter_data'], 'note': '', 'reviews': [],
                       'provenance': {'local_source': source_version(), 'web_fixture': FIXTURE,
                                      'reader_catalog': CATALOG, 'profiles': REGISTRY,
                                      'reader_runtime': '响应未上报构建版本；本地源码版本不证明运行服务版本'}}
            save(session)
            return response(session)

    @app.get('/api/sessions/{sid}')
    async def get_session(sid: str):
        return response(load(sid))

    @app.post('/api/sessions/{sid}/images')
    async def upload(sid: str, file: UploadFile = File(...)):
        data = await file.read(MAX_IMAGE + 1)
        if not data or len(data) > MAX_IMAGE:
            raise HTTPException(413, '图片为空或超过 20 MiB')
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.width * image.height > 40_000_000:
                    raise ValueError()
                fmt = image.format
                if fmt not in ('JPEG', 'PNG', 'WEBP'):
                    raise ValueError()
                image.verify()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            raise HTTPException(422, '请选择 JPEG、PNG 或 WebP 图片，最大 4000 万像素；HEIC 请转为 JPEG') from None
        sha = hashlib.sha256(data).hexdigest()
        async with lock:
            session = load(sid)
            if any(im['sha256'] == sha for im in session['images']):
                return response(session)
            if len(session['images']) >= MAX_IMAGES:
                raise HTTPException(422, '每批最多 30 张，请新建批次')
            iid = str(uuid4())
            (folder(sid) / (iid + '.image')).write_bytes(data)
            session['images'].append({'id': iid, 'filename': Path(file.filename or 'photo').name[:200],
                                      'sha256': sha, 'format': fmt, 'attempts': [], 'mold_target': '', 'excluded': False})
            session['revision'] += 1
            save(session)
        return await run(sid, iid)

    @app.post('/api/sessions/{sid}/images/{iid}/recognize')
    async def run(sid: str, iid: str):
        session = load(sid)
        image = next((im for im in session['images'] if im['id'] == iid), None)
        if not image:
            raise HTTPException(404, '照片不存在')
        attempt = {'created_at': now()}
        async with gpu_queue:
            try:
                result = await read_image((folder(sid) / (image['id'] + '.image')).read_bytes(), image['filename'])
                if isinstance(result, dict) and ('sections' in result or 'questions' in result):
                    validate_draft(result)
                elif not isinstance(result, dict) or not isinstance(result.get('fields'), (dict, type(None))):
                    raise ValueError('Reader 结果不合法')
                attempt['result'] = deepcopy(result)
            except HTTPException as exc:
                attempt['error'] = exc.detail
            except (httpx.HTTPError, ValueError, TypeError, RecursionError):
                attempt['error'] = 'Reader 无法连接或返回了非法结果；保留上次有效结果'
        async with lock:
            session = load(sid)
            next(im for im in session['images'] if im['id'] == iid)['attempts'].append(attempt)
            session['revision'] += 1
            save(session)
        return response(session)

    @app.get('/api/sessions/{sid}/images/{iid}')
    async def photo(sid: str, iid: str):
        image = next((im for im in load(sid)['images'] if im['id'] == iid), None)
        if not image:
            raise HTTPException(404, '照片不存在')
        return FileResponse(folder(sid) / (image['id'] + '.image'),
                            media_type={'JPEG': 'image/jpeg', 'PNG': 'image/png', 'WEBP': 'image/webp'}[image['format']])

    @app.put('/api/sessions/{sid}/review')
    async def review(sid: str, body: Review):
        async with lock:
            session = load(sid)
            if session['revision'] != body.expected_revision:
                raise HTTPException(409, '批次已变化；请刷新后重新核对，当前编辑尚未保存')
            try:
                validate_target(body.target if body.target is not None else session['target'])
                images = {image['id']: image for image in session['images']}
                for iid, draft in body.drafts.items():
                    if (iid not in images or not isinstance(draft, dict)
                            or set(draft) != {'attempt', 'result', 'confirmed'}
                            or type(draft['attempt']) is not int or type(draft['confirmed']) is not bool):
                        raise ValueError()
                    attempt, raw = latest_result(images[iid])
                    if not raw or 'sections' not in raw or draft['attempt'] != attempt:
                        raise HTTPException(409, '候选来源已变化；请重新核对')
                    validate_draft(draft['result'])
                if len(body.edits) > 3000:
                    raise ValueError()
                for edit in body.edits.values():
                    if not isinstance(edit, dict) or set(edit) - {'value', 'target', 'confirmed', 'excluded', 'note'}:
                        raise ValueError()
                    if 'target' in edit and not isinstance(edit['target'], str):
                        raise ValueError()
                    if any(k in edit and type(edit[k]) is not bool for k in ('confirmed', 'excluded')):
                        raise ValueError()
                    if 'note' in edit and (not isinstance(edit['note'], str) or len(edit['note']) > 1000):
                        raise ValueError()
            except (ValueError, TypeError, AttributeError, RecursionError):
                raise HTTPException(422, '目标或纠错格式不合法') from None
            if body.target is not None:
                session['target'] = body.target
            if 'edits' in body.model_fields_set:
                session['edits'] = body.edits
            if 'note' in body.model_fields_set:
                session['note'] = body.note
            session.setdefault('draft_reviews', {}).update(deepcopy(body.drafts))
            for image in session['images']:
                update = body.images.get(image['id'], {})
                if not isinstance(update, dict) or set(update) - {'excluded', 'mold_target'}:
                    raise HTTPException(422, '照片设置不合法')
                if 'excluded' in update and type(update['excluded']) is not bool:
                    raise HTTPException(422, '排除标记必须是布尔值')
                if 'mold_target' in update and not isinstance(update['mold_target'], str):
                    raise HTTPException(422, '模温目标必须是文字 ID')
                image.update(update)
            result = response(session)  # Validate before replacing any persisted state.
            session['reviews'].append({'created_at': now(), 'revision': session['revision'],
                                      'target': session['target'], 'edits': session['edits'], 'images': body.images,
                                      'drafts': deepcopy(session['draft_reviews']),
                                      'note': session['note'], 'preview': result['preview']})
            session['revision'] += 1
            save(session)
            return response(session)

    @app.get('/api/sessions/{sid}/export')
    async def export(sid: str, bundle: bool = False):
        session = load(sid)
        data = json.dumps(response(session), ensure_ascii=False, allow_nan=False, indent=2).encode()
        if not bundle:
            return Response(data, media_type='application/json',
                            headers={'Content-Disposition': 'attachment; filename="hmi-validation.json"'})
        fd, name = tempfile.mkstemp(suffix='.zip', dir=root)
        os.close(fd)
        path = Path(name)
        try:
            with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('result.json', data)
                for im in session['images']:
                    extension = {'JPEG': 'jpg', 'PNG': 'png', 'WEBP': 'webp'}[im['format']]
                    archive.write(folder(sid) / (im['id'] + '.image'), f"images/{im['id']}.{extension}")
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return FileResponse(path, media_type='application/zip', filename='hmi-validation.zip',
                            background=BackgroundTask(path.unlink, missing_ok=True))

    return app


if __name__ == '__main__':
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', default=8766, type=int)
    args = parser.parse_args()
    if args.host not in ('127.0.0.1', '::1', 'localhost') and not os.getenv('HMI_LAB_PASSWORD'):
        parser.error('局域网监听需设置 HMI_LAB_PASSWORD；用户名 lab。请使用可信局域网或 HTTPS 代理。')
    uvicorn.run(create_app(), host=args.host, port=args.port)
