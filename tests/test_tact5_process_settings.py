"""TACT5 routing, observations and original-image evidence; synthetic, no model calls."""
import json
import sys
import pytest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from extract_fields import extract_one, load_template, route_page
from extract_families.tact5_process import extract_tact5, recover_stage_counts
from extract_families.tact_injection import extract_injection_tact


def line(text, x, y, confidence=.99):
    return dict(text=text, conf=confidence, bbox=dict(x_min=x, y_min=y, x_max=x+40, y_max=y+20))


def sample():
    return [line('充填速度', 20, 180), line('2段', 20, 210),
            line('V1', 400, 180), line('100mm/s', 420, 210),
            line('V3', 200, 180), line('35mm/s', 220, 210),
            line('SM', 500, 280), line('30mm', 520, 310),
            line('保压', 20, 380), line('1段', 20, 410),
            line('Pp1', 400, 380), line('100MPa', 420, 410),
            line('Pp2', 300, 380), line('90MPa', 320, 410),
            line('Tp1', 400, 480), line('2s', 420, 510),
            line('冷却', 20, 50), line('7s', 100, 50),
            line('VS1', 800, 280), line('1段', 800, 220), line('165rpm', 820, 310),
            line('VSL1', 800, 380), line('30mm', 820, 410),
            line('计量前', 800, 580), line('计量后', 900, 580)]


def template():
    return load_template('TACT5', 'process_settings', ROOT / 'templates')


def test_template_route_does_not_mistake_old_tact():
    assert route_page('any', sample(), 'TACT', ROOT / 'templates') == ('process_settings', 'template_anchors')
    old = [line('充填速度', 1, 1), line('保压', 1, 2), line('VP转换位置', 1, 3)]
    assert route_page('old', old, 'TACT', ROOT / 'templates')[0] == 'injection_metering'
    assert load_template('TACT', 'injection_metering', ROOT / 'templates')['ui_family'] == 'TACT'
    assert extract_injection_tact([], load_template('TACT', 'injection_metering', ROOT/'templates'))['fields']['fill_stages'] == 3


def test_counts_residuals_chinese_and_original_boxes():
    meta = dict(screen_size=[1000, 700], original_size=[2000, 1400],
                screen_quad=[[0,0],[1998,0],[1998,1398],[0,1398]])
    result = extract_tact5(sample(), template(), meta)
    facts = result['detail']['page_observations']
    rows = {f['label']: f for f in facts['fields']}
    assert facts['stage_counts']['injection']['value'] == 2
    assert rows['V1']['value'] == 100 and rows['V1']['state'] == 'enabled'
    assert rows['V3']['value'] == 35 and rows['V3']['state'] == 'disabled'
    assert rows['Pp2']['value'] == 90 and rows['Pp2']['state'] == 'disabled'
    assert rows['Tp1']['state'] == rows['VSL1']['state'] == 'disabled'
    assert rows['冷却']['value'] == 7 and rows['冷却']['unit'] == 's'
    assert rows['冷却']['original_bbox'] == pytest.approx([10., 50/7, 14., 10.])
    assert result['fields'] == {}  # No automatic business writes from unreviewed observations.


def test_missing_count_and_unit_stay_unknown_and_ambiguous_values_unset():
    lines = [l for l in sample() if l['text'] not in ('1段', '2段')]
    lines += [line('8s', 105, 50)]
    facts = extract_tact5(lines, template(), dict(screen_size=[1000,700]))['detail']['page_observations']
    rows = {f['label']: f for f in facts['fields']}
    assert not facts['stage_counts']
    assert rows['V3']['state'] == 'unknown'
    assert rows['冷却']['value'] is None
    assert all(f['original_bbox'] is None for f in facts['fields'])


def test_extract_one_publishes_registered_candidate(tmp_path):
    (tmp_path/'x.ocr.json').write_text(json.dumps(dict(lines=sample())))
    (tmp_path/'x.rectify.json').write_text(json.dumps(dict(ok=True, screen_size=[1000,700])))
    result = extract_one('x', tmp_path, None, None, ROOT/'templates')
    assert result['profile_id'] == template()['profile_id']
    assert result['profile_status'] == 'candidate' and result['status'] == 'review'
    assert result['provenance']['template'].startswith(template()['profile_id'] + '.json')


def test_http_and_feishu_keep_the_same_page_observations(tmp_path, monkeypatch):
    import asyncio
    import io
    import cv2
    import numpy as np
    import hmi_service as service
    import feishu_card_assistant as card
    from quality import QualityReport
    from fastapi import UploadFile
    meta = dict(ok=True, screen_size=[1000,700], original_size=[1000,700],
                screen_quad=[[0,0],[999,0],[999,699],[0,699]])
    photo = np.full((700,1000,3),255,dtype=np.uint8)
    def rectify(original, target, metadata=None, max_size=None):
        cv2.imwrite(str(target), photo)
        if metadata:
            Path(metadata).write_text(json.dumps(meta))
        return meta
    class OCR:
        def ocr(self, *args, **kwargs):
            return [[[[[l['bbox']['x_min'],l['bbox']['y_min']], [l['bbox']['x_max'],l['bbox']['y_min']],
                        [l['bbox']['x_max'],l['bbox']['y_max']], [l['bbox']['x_min'],l['bbox']['y_max']]],
                       (l['text'],l['conf'])] for l in sample()]]
    monkeypatch.setattr(service,'is_ready',True)
    monkeypatch.setattr(service,'ocr_model',OCR())
    monkeypatch.setattr(service,'assess',lambda *a: QualityReport(filename='fixture',triage='green'))
    monkeypatch.setattr(service,'rectify',rectify)
    monkeypatch.setattr(service,'postprocess_one',lambda *a: {})
    monkeypatch.setattr(service,'classify',lambda *a: dict(ui_family='TACT',page='injection_metering'))
    # The same local observation function is called through both entry points; no external message is sent.
    monkeypatch.setattr(card,'assess',service.assess)
    monkeypatch.setattr(card,'rectify',rectify)
    monkeypatch.setattr(card,'run_ocr_for_image',lambda *a: sample())
    monkeypatch.setattr(card,'TEMPLATES_DIR',ROOT/'templates')
    source=tmp_path/'test.png';cv2.imwrite(str(source),photo)
    result=card.process_hmi_image(source,tmp_path/'card')
    _, encoded=cv2.imencode('.png',photo)
    async def run():
        monkeypatch.setattr(service,'concurrency_semaphore',asyncio.Semaphore(1))
        return await service.recognize_image(UploadFile(file=io.BytesIO(encoded.tobytes()),filename='test.png'),include_review_image=False)
    response=asyncio.run(run())
    assert response['page_observations'] == result['page_observations']
    assert response['profile_id'] == result['profile_id'] == template()['profile_id']
    assert response['status'] == result['status'] == 'review'


def test_fixed_real_ocr_does_not_guess_missing_counts():
    lines = json.loads((ROOT/'tests/fixtures/tact5_process_ocr.json').read_text())['lines']
    assert route_page('sample',lines,'TACT',ROOT/'templates')[0] == 'process_settings'
    facts = extract_tact5(lines,template(),dict(screen_size=[1418,1077]))['detail']['page_observations']
    rows = {f['label']:f for f in facts['fields']}
    assert rows['冷却']['value'] == 7 and rows['冷却']['unit'] == 's'
    assert rows['Pp1']['value'] == 105  # Old substring matching incorrectly selected Pp3's 90.
    assert rows['SV2']['value'] == 15
    assert rows['计量后距离']['value'] == 10
    assert facts['stage_counts']['holding']['value'] == 2
    assert 'injection' not in facts['stage_counts'] and 'plasticizing' not in facts['stage_counts']
    assert rows['Sv3']['state'] == 'unknown'


def test_cropped_count_requires_printed_suffix_and_section_anchor(tmp_path):
    import cv2
    import numpy as np

    image = tmp_path/'screen.png'
    cv2.imwrite(str(image), np.full((700, 1000, 3), 255, dtype=np.uint8))
    lines = [line('充填速度', 20, 180), line('段', 120, 225),
             line('VS1', 700, 300), line('段', 770, 250)]
    class OCR:
        def ocr(self, crop, cls=False):
            return [[([[10, 10], [30, 10], [30, 40], [10, 40]], ('3', .99)),
                     ([[35, 10], [65, 10], [65, 40], [35, 40]], ('段', .99))]]

    extra = recover_stage_counts(OCR(), image, lines, [1000, 700],
                                 {'injection', 'plasticizing'})
    assert [item['text'] for item in extra] == ['3段', '3段']
    assert recover_stage_counts(OCR(), image, lines, [1000, 700], set()) == []
    lines[1]['text'] = 'unknown'
    assert [item['text'] for item in recover_stage_counts(
        OCR(), image, lines, [1000, 700], {'injection', 'plasticizing'})] == ['3段']
