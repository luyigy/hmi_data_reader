"""Offline human acceptance report using real uploads to the running Reader.

No OCR is injected into HTTP. Derived crops are labeled and hashed. Full server
responses remain beside the HTML, which embeds images for standalone viewing.
"""
import argparse
import asyncio
import base64
import hashlib
import html
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import cv2
import httpx

from rectify import rectify

ROOT = Path(__file__).resolve().parents[1]
BR = 'b_and_r.injection_holding.multi_stage_position_time'
TACT5 = 'tact5.process_settings.injection_holding_metering'


def prepare(output):
    output.mkdir(parents=True, exist_ok=True)
    br = ROOT/'tests/fixtures/b_and_r_stability/live_20261029_curve_context.jpg'
    ns = ROOT/'datasets/r6_nissei'/TACT5/'development/Z078_20260910_shebao.jpg'
    manifest = json.loads((ROOT/'tests/fixtures/b_and_r_stability/manifest.json').read_text())
    older = ROOT/next(s['original'] for s in manifest['samples'] if 'rank01' in s['id'])
    rectified = {}
    for key, source in [('br', br), ('nissei', ns)]:
        target = output/f'{key}_rectified.png'
        meta = rectify(source, target)
        if not meta['ok']:
            raise ValueError(f'Cannot prepare source: {source}')
        rectified[key] = cv2.imread(str(target))
    definitions = [
        ('br_full', '完整 B&R，射胶4段/保压2段', br, None, None, 'matched', BR, False),
        ('br_other_stages', '不同段数 B&R，射胶3段/保压3段', older, None, None, 'matched', BR, False),
        ('br_local', 'B&R 局部，保留射胶/保压/切换表', br, 'br', [0, 430, 1155, 1366], 'matched', BR, False),
        ('numbers_only', '仅数字裁剪，不应确认模板', br, 'br', [300, 530, 1050, 700], 'unknown', None, False),
        ('nissei_local', '日精右侧局部，保留完整 VS/PB/VSL 及下方边界', ns, 'nissei', [990, 440, 1418, 1077], 'matched', TACT5, False),
        ('page_without_values', '页面确认但缺保压/切换，字段提取失败', br, 'br', [100, 440, 1130, 750], 'matched', BR, True),
        ('nissei_family_only', '日精左侧局部，缺少子页判别证据', ns, 'nissei', [0, 400, 990, 760], 'unknown', None, False),
    ]
    cases = []
    for key, title, source, image_key, crop, expected, profile, no_fields in definitions:
        path = source
        if crop:
            x0, y0, x1, y1 = crop
            path = output/f'{key}.png'
            cv2.imwrite(str(path), rectified[image_key][y0:y1, x0:x1])
        cases.append(dict(id=key, title=title, source=str(source.relative_to(ROOT)),
            image=str(path.resolve()), crop=crop, expected=expected, expected_profile=profile,
            expect_extraction_failure=no_fields, input_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            source_sha256=hashlib.sha256(source.read_bytes()).hexdigest()))
    return cases


def run(output, url):
    cases = prepare(output)
    with httpx.Client(timeout=240, trust_env=False) as client:
        health = client.get(url+'/ready')
        health.raise_for_status()
        for case in cases:
            image = Path(case['image'])
            response = client.post(url+'/api/v1/recognize',
                files={'file': (image.name, image.read_bytes(), 'image/png' if image.suffix == '.png' else 'image/jpeg')})
            case['http_status'] = response.status_code
            case['response'] = response.json()
            data = case['response']
            routing = data.get('page_routing') or {}
            ocr_ran = bool(data.get('ocr_evidence'))
            case['ocr_mode'] = 'fresh_service_ocr' if ocr_ran else 'not_run_or_not_returned'
            case['actual'] = routing.get('status', 'not_routed')
            case['passed'] = (response.status_code == 200 and ocr_ran
                and case['actual'] == case['expected']
                and (not case['expected_profile'] or data.get('profile_id') == case['expected_profile'])
                and (not case['expect_extraction_failure'] or data.get('fields') is None))
            (output/f"{case['id']}.response.json").write_text(json.dumps(data, ensure_ascii=False, indent=2))
            print(case['id'], response.status_code, case['actual'], data.get('profile_id'),
                  data.get('status'), 'PASS' if case['passed'] else 'FAIL', flush=True)
    cases.append(replay_numeric_http(output, next(c for c in cases if c['id'] == 'numbers_only')))
    document = dict(timestamp=datetime.now(timezone.utc).isoformat(), endpoint=url+'/api/v1/recognize',
        source_base_commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        source_diff_sha256=hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD'], cwd=ROOT)).hexdigest(),
        cases=cases)
    (output/'results.json').write_text(json.dumps(document, ensure_ascii=False, indent=2))
    render(output, document)


def replay_numeric_http(output, source_case):
    """Explicit frozen transport replay, never described as live crop OCR.

    The real upload handler runs in-process. Quality is bypassed to reach the
    routing seam because the running service rejects this crop before OCR.
    """
    import shutil
    import sys
    sys.path.insert(0, str(ROOT))
    import hmi_service as service
    from quality import QualityReport

    case = {**source_case, 'id': 'numbers_only_frozen_http',
            'title': '仅数字裁剪：冻结 OCR 经 HTTP 处理器回放，显式绕过质量门禁'}
    x0, y0, x1, y1 = case['crop']
    frozen = json.loads((ROOT/'tests/fixtures/b_and_r_stability/live_20261029_curve_context.json').read_text())['ocr_evidence']
    lines = []
    for line in frozen['lines']:
        a,b,c,d = line['bbox']
        if x0 <= a < c <= x1 and y0 <= b < d <= y1:
            lines.append([[[a-x0,b-y0],[c-x0,b-y0],[c-x0,d-y0],[a-x0,d-y0]],
                          (line['text'], line['confidence'])])

    class FrozenOCR:
        def ocr(self, *args, **kwargs):
            return [lines]

    def fixed_rectification(original, target, metadata=None, max_size=None):
        shutil.copyfile(original, target)
        meta = dict(ok=True, method='frozen_crop_identity', screen_size=[x1-x0,y1-y0],
            original_size=[x1-x0,y1-y0], screen_quad=[[0,0],[x1-x0,0],[x1-x0,y1-y0],[0,y1-y0]])
        if metadata:
            Path(metadata).write_text(json.dumps(meta))
        return meta

    async def upload():
        service.concurrency_semaphore = asyncio.Semaphore(1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url='http://frozen-replay') as client:
            return await client.post('/api/v1/recognize', files={'file': ('numeric.png', Path(case['image']).read_bytes(), 'image/png')})

    with patch.object(service, 'is_ready', True), patch.object(service, 'ocr_model', FrozenOCR()), \
            patch.object(service, 'assess', lambda *args: QualityReport(filename='frozen', triage='green')), \
            patch.object(service, 'rectify', fixed_rectification):
        response = asyncio.run(upload())
    case['response'] = response.json()
    case['http_status'] = response.status_code
    case['ocr_mode'] = 'frozen_ocr_http_replay_quality_bypassed'
    case['actual'] = (case['response'].get('page_routing') or {}).get('status', 'not_routed')
    case['passed'] = response.status_code == 200 and case['actual'] == 'unknown'
    (output/f"{case['id']}.response.json").write_text(json.dumps(case['response'], ensure_ascii=False, indent=2))
    return case


def render(output, document):
    escape = html.escape
    cards = []
    for case in document['cases']:
        data = case['response']
        routing = data.get('page_routing') or {}
        source = ROOT/case['source']
        images = []
        for title, path in [('原始照片', source), ('实际上传图片', Path(case['image']))]:
            mime = 'image/png' if path.suffix == '.png' else 'image/jpeg'
            encoded = base64.b64encode(path.read_bytes()).decode()
            images.append(f'<figure><figcaption>{title}</figcaption><img src="data:{mime};base64,{encoded}"></figure>')
        fields = (data.get('page_observations') or {}).get('fields', [])
        rows = ''.join('<tr>'+''.join(f'<td>{escape(str(f.get(k)))}</td>' for k in
            ['label', 'value', 'unit', 'stage', 'state', 'state_basis', 'reasons'])+'</tr>' for f in fields)
        badge = '通过' if case['passed'] else '未通过'
        details = {k: data.get(k) for k in ['controller_family', 'page_type', 'profile_id', 'status', 'quality', 'warnings', 'fields']}
        details['品牌'] = {BR: '伯乐 B&R', TACT5: '日精 TACT5'}.get(data.get('profile_id'), '未确认')
        details['页面名称'] = {BR: '射胶/保压多段位置时间页', TACT5: '射出/计量工艺设置页'}.get(data.get('profile_id'), '未确认')
        cards.append(f'<article><h2>{escape(case["title"])} · {badge}</h2><p>OCR：{case["ocr_mode"]}；'
            f'HTTP {case["http_status"]}；预期 {case["expected"]}，实际 {case["actual"]}</p>'
            f'<p>来源 {escape(case["source"])}；裁剪坐标 {case["crop"]}；输入 SHA256 {case["input_sha256"]}</p>'
            '<div class="images">'+''.join(images)+'</div>'
            '<h3>路由证据、缺失及冲突</h3><pre>'+escape(json.dumps(routing, ensure_ascii=False, indent=2))+'</pre>'
            '<h3>品牌、页面及字段提取</h3><pre>'+escape(json.dumps(details, ensure_ascii=False, indent=2))+'</pre>'
            '<table><tr><th>字段</th><th>值</th><th>单位</th><th>段号</th><th>状态</th><th>状态依据</th><th>限制</th></tr>'+rows+'</table></article>')
    failures = [c['id'] for c in document['cases'] if not c['passed']]
    page = '<!doctype html><html lang="zh"><meta charset="utf-8"><title>S01.1 人工验收</title><style>'
    page += 'body{font:15px system-ui;max-width:1300px;margin:auto;padding:24px;background:#f4f6f8}article{background:white;padding:20px;margin:24px 0}.images{display:flex;gap:20px}figure{width:50%;margin:0}img{max-width:100%;max-height:700px;object-fit:contain}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f6;padding:12px}td,th{border:1px solid #bbb;padding:6px}table{border-collapse:collapse;width:100%}</style>'
    page += '<h1>S01.1 页面路由人工验收</h1><p>前七项通过运行中 Reader 的真实 HTTP 上传入口重新 OCR；质量门禁提前拒绝的项标为未运行。最后一项是冻结 OCR 在同一个 HTTP 处理器上的进程内回放，显式绕过质量门禁，只验证后续路由，不能算真实裁剪 OCR 成功。裁剪均为已知开发照片的派生样本，不是独立盲测。</p>'
    page += '<p>独立路由身份与字段可用性分开判断；unknown 是允许的安全结果。未接入插件的旧页面用 unsupported 标注，继续旧兼容路径。</p>'
    page += '<pre>'+escape(json.dumps({k:v for k,v in document.items() if k != 'cases'}, ensure_ascii=False, indent=2))+'</pre>'
    page += '<p>失败清单：'+escape(', '.join(failures) or '无')+'</p>'+''.join(cards)+'</html>'
    (output/'report.html').write_text(page)
    summary = dict(total=len(document['cases']), passed=len(document['cases'])-len(failures), failures=failures,
                   fresh_ocr=sum(c['ocr_mode']=='fresh_service_ocr' for c in document['cases']),
                   frozen_ocr=sum(c['ocr_mode'].startswith('frozen_ocr') for c in document['cases']))
    (output/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--url', default='http://127.0.0.1:8767')
    parser.add_argument('--render-only', action='store_true')
    args = parser.parse_args()
    if args.render_only:
        render(args.output, json.loads((args.output/'results.json').read_text()))
    else:
        run(args.output, args.url.rstrip('/'))
