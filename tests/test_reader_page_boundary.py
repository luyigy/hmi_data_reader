"""B&R-only runtime boundary, frozen package integrity, CLI and HTTP transport."""
import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from unittest.mock import patch

import cv2
import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import hmi_service as service
import page_template_admin as admin
import page_template_lifecycle as lifecycle
from extract_fields import extract_one
from extractor_registry import capabilities
from export_page_package import export_page_package
from page_identity import PLUGINS, route_identities
from raw_contract import canonical_hash, validate_raw_record
from raw_observations import observe_temperature_time_page, select_raw_profile
from quality import QualityReport

ROOT = Path(__file__).resolve().parents[1]
PROFILE = 'b_and_r.injection_holding.multi_stage_position_time'


@pytest.fixture
def frozen(tmp_path):
    data = json.loads((ROOT/'tests/fixtures/b_and_r_stability/live_20261029_low_contrast.json').read_text())
    evidence = data['ocr_evidence']
    lines = []
    for row in evidence['lines']:
        box = row['bbox']
        if isinstance(box, list):
            box = dict(zip(('x_min', 'y_min', 'x_max', 'y_max'), box))
        lines.append(dict(text=row['text'], conf=row.get('conf', row.get('confidence')), bbox=box))
    meta = data['rectify']
    (tmp_path/'photo.ocr.json').write_text(json.dumps(dict(lines=lines)))
    (tmp_path/'photo.rectify.json').write_text(json.dumps(meta))
    return tmp_path, meta, lines


def test_only_one_page_and_one_extractor_are_active():
    registered = json.loads((ROOT/'contracts/profiles.json').read_text())['profiles']
    assert [p['profile_id'] for p in registered] == list(PLUGINS) == [PROFILE]
    assert [x['extractor_id'] for x in capabilities()['extractors']] == ['b_and_r.injection_metering']
    assert capabilities()['generic_fallback']['enabled'] is False


@pytest.mark.parametrize('fixture', [
    'demag_holding_z002_ocr.json', 'demag_metering_z002_ocr.json',
    'demag_injection_z002_wehdt_ocr.json', 'tact5_process_ocr.json',
])
def test_retired_real_page_is_rejected_by_cli_entry(tmp_path, fixture):
    data = json.loads((ROOT/'tests/fixtures'/fixture).read_text())
    for row in data['lines']:
        row['conf'] = row.get('conf', row.get('confidence', .99))
        if isinstance(row['bbox'], list):
            row['bbox'] = dict(zip(('x_min', 'y_min', 'x_max', 'y_max'), row['bbox']))
    (tmp_path/'photo.ocr.json').write_text(json.dumps(data))
    (tmp_path/'photo.rectify.json').write_text(json.dumps(dict(ok=True, screen_size=[2000, 1500])))
    result = extract_one('photo', tmp_path, None, None, ROOT/'templates')
    assert result['status'] == 'reject' and result.get('fields') is None
    assert result['page_routing']['profile_id'] is None
    assert 'PAGE_UNSUPPORTED' in result['warnings']
    assert result['compatibility']['code'] == 'PAGE_UNSUPPORTED'


@pytest.mark.parametrize('profile', ['demag.injection_metering.multi_stage_holding',
                                    'b_and_r.temperature.dynamic', 'generic.spatial'])
def test_retired_page_has_no_package_or_v2_route(profile):
    with pytest.raises(ValueError, match='Unsupported page'):
        export_page_package(profile, '0.6.0')
    with pytest.raises(ValueError, match='RAW_PAGE_UNSUPPORTED'):
        select_raw_profile(profile, [])


def test_b_and_r_cli_and_http_use_same_real_extraction(frozen, monkeypatch):
    directory, meta, lines = frozen
    # Frozen OCR verifies transport and real page logic; this is not a fresh OCR test.
    cli = subprocess.run([sys.executable, 'scripts/extract_fields.py', 'photo',
        '--rectified-dir', str(directory), '--output-dir', str(directory/'out'),
        '--record-report', str(directory/'absent.json'), '--labels', str(directory/'absent.json')],
        cwd=ROOT, text=True, capture_output=True)
    assert cli.returncode == 0, cli.stderr
    expected = json.loads((directory/'out/photo.fields.json').read_text())
    assert expected['profile_id'] == PROFILE and expected['fields']

    class FrozenOCR:
        def ocr(self, *args, **kwargs):
            return [[[[[r['bbox']['x_min'], r['bbox']['y_min']],
                       [r['bbox']['x_max'], r['bbox']['y_min']],
                       [r['bbox']['x_max'], r['bbox']['y_max']],
                       [r['bbox']['x_min'], r['bbox']['y_max']]], (r['text'], r['conf'])] for r in lines]]

    def rectify(original, target, metadata=None, max_size=None):
        image = cv2.imread(str(original))
        cv2.imwrite(str(target), image)
        if metadata:
            Path(metadata).write_text(json.dumps(meta))
        return meta

    image = ROOT/'tests/fixtures/b_and_r_stability/live_20261029_curve_context.jpg'
    monkeypatch.delenv('HMI_API_KEY', raising=False)
    monkeypatch.setattr(service, 'is_ready', True)
    monkeypatch.setattr(service, 'ocr_model', FrozenOCR())
    monkeypatch.setattr(service, 'rectify', rectify)
    monkeypatch.setattr(service, 'assess', lambda *a: QualityReport(filename='frozen', triage='green'))
    monkeypatch.setattr(service, 'concurrency_semaphore', asyncio.Semaphore(1))
    async def upload():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url='http://test') as client:
            return await client.post('/api/v1/recognize', files={'file': ('screen.jpg', image.read_bytes(), 'image/jpeg')})
    response = asyncio.run(upload())
    assert response.status_code == 200, response.text
    actual = response.json()
    assert actual['profile_id'] == PROFILE
    # HTTP provides pixels; compare stable raw numeric observations rather than enabled-stage inference.
    assert actual['page_routing']['status'] == expected['page_routing']['status'] == 'matched'
    assert actual['ocr_evidence']['lines']


def test_old_package_immutable_and_new_package_tracks_moved_sources():
    before = subprocess.check_output(['git', 'show',
        f'backup/reader-before-page-cleanup-20261102:templates/raw-packages/{PROFILE}/0.6.0.json'], cwd=ROOT)
    assert before == (ROOT/'templates/raw-packages'/PROFILE/'0.6.0.json').read_bytes()
    assert export_page_package(PROFILE, '0.6.0')['version'] == '0.6.0'
    package = export_page_package(PROFILE, '0.6.3')
    for path, digest in package['recognizer']['files'].items():
        assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest() == digest
    assert package['version'] == '0.6.3'


def test_v2_observations_have_valid_moved_package_identity():
    package = export_page_package(PROFILE, '0.6.3')
    sample = package['samples'][0]
    manifest = sample['manifest']
    # Package-frozen OCR. No transform is invented when this fixture lacks one.
    meta = dict(screen_size=manifest['screen_size'], original_size=manifest['original_size'])
    result = observe_temperature_time_page(PROFILE, sample['ocr']['lines'], meta, manifest['original_sha256'])
    result['engine'] = {'library': 'frozen_ocr'}
    validate_raw_record(result, package)
    assert len(result['fields']) == 47
    assert result['raw_field_definition_version'] == '0.6.3'


def test_draft_creation_cannot_reenable_an_unimplemented_page(tmp_path):
    with pytest.raises(Exception) as error:
        lifecycle.save_draft(tmp_path, 'demag.injection_metering.multi_stage_holding', {}, [], None)
    assert error.value.status_code == 422
    assert 'PAGE_UNSUPPORTED' in str(error.value.detail)
    assert not (tmp_path/'templates/drafts').exists()


def test_template_api_lists_only_retained_page(monkeypatch):
    monkeypatch.setattr(admin, 'ROOT', ROOT)
    app = FastAPI()
    app.include_router(admin.router)
    client = TestClient(app)
    response = client.get('/api/v1/page-templates')
    assert response.status_code == 200
    assert [row['profile_id'] for row in response.json()] == [PROFILE]
    assert client.get('/api/v1/page-templates/demag.injection_metering.multi_stage_holding').status_code == 404


@pytest.mark.parametrize('version,code', [('v1', 200), ('v2', 422)])
def test_unsupported_http_upload_never_extracts_or_retries(monkeypatch, version, code):
    import io
    import numpy as np
    from fastapi import UploadFile, HTTPException
    calls = []
    class UnknownOCR:
        def ocr(self, *args, **kwargs):
            calls.append('ocr')
            return [[[[[10, 10], [30, 10], [30, 20], [10, 20]], ('30.0', .99)]]]
    def rectify(original, target, metadata=None, max_size=None):
        shutil.copyfile(original, target)
        meta = dict(ok=True, screen_size=[100, 100], original_size=[100, 100])
        if metadata:
            Path(metadata).write_text(json.dumps(meta))
        return meta
    _, pixels = cv2.imencode('.png', np.full((100, 100, 3), 255, dtype=np.uint8))
    monkeypatch.setattr(service, 'is_ready', True)
    monkeypatch.setattr(service, 'ocr_model', UnknownOCR())
    monkeypatch.setattr(service, 'rectify', rectify)
    monkeypatch.setattr(service, 'assess', lambda *a: QualityReport(filename='unknown', triage='green'))
    monkeypatch.setattr(service, 'classify', lambda *a: {'ui_family': 'DEMAG', 'page': 'injection_metering'})
    monkeypatch.setattr(service, 'concurrency_semaphore', asyncio.Semaphore(1))
    upload = UploadFile(file=io.BytesIO(pixels.tobytes()), filename='unknown.png')
    if code == 422:
        with pytest.raises(HTTPException) as error:
            asyncio.run(service.recognize_image(upload, observations_version=version))
        assert error.value.status_code == code
    else:
        result = asyncio.run(service.recognize_image(upload, observations_version=version))
        assert not result['fields']
        assert result['page_routing']['status'] == 'unsupported'
        assert result['ocr_evidence']['lines']
    assert calls == ['ocr']


def test_retained_page_draft_is_versioned_and_retired_page_is_rejected(tmp_path):
    package = export_page_package(PROFILE, '0.6.3')
    (tmp_path/'contracts').mkdir()
    (tmp_path/'contracts/profiles.json').write_text(json.dumps({'profiles': []}))
    template = copy.deepcopy(package['template'])
    first = lifecycle.save_draft(tmp_path, PROFILE, template, package['samples'], None)
    assert first['revision'] == 1
    assert lifecycle.read_draft(tmp_path, PROFILE) == first
    with pytest.raises(Exception) as error:
        lifecycle.save_draft(tmp_path, PROFILE, template, package['samples'], None)
    assert error.value.status_code == 409
    assert lifecycle.read_draft(tmp_path, PROFILE) == first


@pytest.mark.parametrize('version', ['0.6.0', '0.6.1', '0.6.2'])
def test_v2_old_binding_is_not_silently_upgraded(version):
    from raw_observations import RawPageRejected
    with pytest.raises(RawPageRejected) as error:
        observe_temperature_time_page(PROFILE, [], {}, 'a'*64, package_version=version)
    assert error.value.detail['code'] == 'RAW_PAGE_VERSION_UNSUPPORTED'


@pytest.mark.parametrize('version', ['0.6.0', '0.6.1', '0.6.2'])
def test_all_historical_raw_packages_remain_byte_identical(version):
    relative = f'templates/raw-packages/{PROFILE}/{version}.json'
    before = subprocess.check_output(['git', 'show', f'31ea239:{relative}'], cwd=ROOT)
    assert before == (ROOT/relative).read_bytes()
    assert export_page_package(PROFILE, version)['version'] == version
