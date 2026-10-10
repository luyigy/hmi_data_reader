"""TACT5 routing, observations and original-image evidence; synthetic, no model calls."""
import json
import sys
import pytest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from extract_fields import extract_one, load_template, route_family, route_page
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


def test_page_route_keeps_controller_and_reports_conflicting_templates(tmp_path):
    lines = [line('DEMAG', 0, 0), line('温度', 0, 20),
             line('实际', 0, 40), line('设定', 0, 60),
             line('上偏差', 0, 80), line('下偏差', 0, 100), line('喷嘴', 0, 120)]
    family, _ = route_family('raw_upload', lines, None, None)
    assert family == 'DEMAG'
    assert route_page('raw_upload', lines, family, ROOT / 'templates') == (
        'temperature', 'template_anchors')
    injection = [line('多级注射', 0, 0), line('工艺优化', 0, 20),
                 line('切换条件', 0, 40)]
    family, _ = route_family('raw_upload', injection, None, None)
    assert family == 'DEMAG'
    assert route_page('raw_upload', injection, family, ROOT / 'templates') == (
        'injection_metering', 'template_anchors')
    tact5 = [line('TACT5', 0, 0), *sample()]
    family, _ = route_family('raw_upload', tact5, None, None)
    assert family == 'TACT'
    assert route_page('raw_upload', tact5, family, ROOT / 'templates') == (
        'process_settings', 'template_anchors')
    assert route_page('raw_upload', tact5, 'DEMAG', ROOT / 'templates')[0] != 'process_settings'

    for page in ('injection_metering', 'settings'):
        (tmp_path / f'demag.{page}.json').write_text(json.dumps({
            'page_detect_anchors': ['共同标签', '共同数值']}))
    conflict = [line('共同标签', 0, 0), line('共同数值', 0, 20)]
    assert route_page('raw_upload', conflict, 'DEMAG', tmp_path) == (
        'unknown', 'ambiguous_template_anchors')
    (tmp_path / 'raw_upload.ocr.json').write_text(json.dumps({
        'lines': [line('DEMAG', 0, 40), *conflict]}))
    (tmp_path / 'raw_upload.rectify.json').write_text(json.dumps({
        'ok': True, 'screen_size': [1000, 700]}))
    result = extract_one('raw_upload', tmp_path, None, None, tmp_path)
    assert result['page_type'] == 'unknown'
    assert result['provenance']['page_source'] == 'ambiguous_template_anchors'
    assert result['status'] != 'ok'


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


def test_visual_count_requires_a_clear_complete_row_and_agrees_with_printed_count(tmp_path):
    import cv2
    import numpy as np
    from extract_families.common import bbox_grayscale_contrast

    lines = [line('充填速度', 20, 180)]
    image = np.full((700, 1000), 180, dtype=np.uint8)
    for stage in range(1, 7):
        x = 80 + 130 * (stage - 1)
        lines.extend([line(f'V{stage}', x, 180), line(f'{stage}mm/s', x + 20, 210)])
        image[210:230, x + 20:x + 40] = 60 if stage <= 3 else 140
    path = tmp_path / 'screen.png'

    def states(ocr_lines=lines):
        cv2.imwrite(str(path), image)
        fields = extract_tact5(ocr_lines, template(), dict(screen_size=[1000, 700]), path)['detail']['page_observations']['fields']
        return {field['label']: field for field in fields}

    assert bbox_grayscale_contrast(image, [100, 210, 140, 230]) == 120
    rows = states()
    assert [rows[f'V{i}']['state'] for i in range(1, 7)] == ['enabled'] * 3 + ['disabled'] * 3
    assert rows['V4']['reasons'] == []
    facts = extract_tact5(lines, template(), dict(screen_size=[1000, 700]), path)['detail']['page_observations']
    assert facts['stage_counts'] == {} and facts['visual_stage_counts'] == {'injection': 3}
    assert states(lines + [line('3段', 20, 210)])['V4']['state'] == 'disabled'
    conflict = states(lines + [line('2段', 20, 210)])
    assert conflict['V1']['state'] == 'unknown'
    assert conflict['V1']['reasons'] == ['visual_stage_count_conflict']

    image[210:230, 100:120] = 140  # A glare/occlusion-like outlier breaks the active group.
    assert states()['V4']['state'] == 'unknown'
    image[210:230, 100:120] = 60
    assert states([item for item in lines if item['text'] != '4mm/s'])['V4']['state'] == 'unknown'
    missing_v6 = states([item for item in lines if item['text'] != '6mm/s'])
    assert missing_v6['V1']['state'] == 'enabled'
    assert missing_v6['V6']['state'] == 'unknown'
    missing_v5_lines = [item for item in lines if item['text'] != '5mm/s']
    missing_v5 = states(missing_v5_lines)
    assert [missing_v5[f'V{i}']['state'] for i in (1, 2, 3, 4, 5, 6)] == [
        'enabled', 'enabled', 'enabled', 'disabled', 'unknown', 'disabled']
    assert missing_v5['V1']['state_basis'] == 'grayscale_v_row_reference'
    assert extract_tact5(missing_v5_lines, template(), dict(screen_size=[1000, 700]), path)[
        'detail']['page_observations']['visual_stage_counts'] == {}
    low_confidence = states([dict(item, conf=.7) if item['text'] == '1mm/s' else item for item in lines])
    assert low_confidence['V1']['state'] == 'unknown'
    assert low_confidence['V2']['state'] == 'enabled'
    image[210:230, 490:510] = 60
    image[210:230, 620:640] = 60
    image[210:230, 750:770] = 60  # No strong boundary remains.
    assert states()['V4']['state'] == 'unknown'
    assert bbox_grayscale_contrast(image, [-1, 0, 10, 10]) is None


def test_retract_phases_use_same_page_brightness_evidence(tmp_path):
    import cv2
    import numpy as np

    lines = [line('PB1', 100, 300), line('5MPa', 100, 330),
             line('PB2', 200, 300), line('5MPa', 200, 330),
             line('PB3', 300, 300), line('5MPa', 300, 330),
             line('计量前', 800, 580), line('计量后', 900, 580),
             line('速度', 730, 610), line('距离', 730, 650),
             line('速度', 830, 610), line('距离', 830, 650),
             line('0', 800, 610), line('30', 900, 610),
             line('0', 800, 650), line('10', 900, 650)]
    image = np.full((700, 1000), 180, dtype=np.uint8)
    for item in lines:
        if item['text'] in ('5MPa', '0', '30', '10'):
            box = item['bbox']
            x, y = int(box['x_min']), int(box['y_min'])
            image[y:y+20, x:x+40] = 220 if x == 100 else 160 if x in (200, 300) else 205
    path = tmp_path/'screen.png'

    def states():
        cv2.imwrite(str(path), image)
        facts = extract_tact5(lines, template(), dict(screen_size=[1000, 700]), path)['detail']['page_observations']
        return {field['label']: field for field in facts['fields']}

    rows = states()
    assert all(rows[label]['state'] == 'enabled' for label in
               ('计量前速度', '计量前距离', '计量后速度', '计量后距离'))
    assert rows['计量后距离']['state_basis'] == 'grayscale_pb_reference'
    assert rows['计量前速度']['value'] == 0
    for x, y, above, inside in ((100, 330, 220, 241), (200, 330, 210, 194),
                                 (300, 330, 198, 191), (800, 610, 195, 217),
                                 (800, 650, 201, 210), (900, 610, 189, 209),
                                 (900, 650, 190, 204)):
        image[y-20:y, x:x+40] = above
        image[y:y+20, x:x+40] = inside
    gradient_rows = states()
    assert all(gradient_rows[label]['state'] == 'enabled' for label in
               ('计量前速度', '计量前距离', '计量后速度', '计量后距离'))
    image[:] = 180
    for item in lines:
        if item['text'] in ('5MPa', '0', '30', '10'):
            box = item['bbox']
            x, y = int(box['x_min']), int(box['y_min'])
            image[y:y+20, x:x+40] = 220 if x == 100 else 160 if x in (200, 300) else 205
    image[610:630, 800:840] = image[650:670, 800:840] = 160
    rows = states()
    assert rows['计量前速度']['state'] == rows['计量前距离']['state'] == 'disabled'
    assert rows['计量后速度']['state'] == 'enabled'
    image[650:670, 800:840] = 205
    assert states()['计量前速度']['state'] == 'unknown'
    assert states()['计量前速度']['state_basis'] is None
    image[330:350, 200:240] = 205
    assert states()['计量后速度']['state'] == 'unknown'
    image[330:350, 200:240] = 160
    next(item for item in lines if item['text'] == '30')['conf'] = .7
    assert states()['计量后速度']['state'] == 'unknown'


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
    assert rows['V-P转换方式']['value'] == '位置'
    assert rows['V-P切换应答']['value'] == '高应答'
    assert rows['手动背压']['value'] == 'OFF'
    assert rows['充填过量防止时间']['value'] == 0
    assert rows['充填过量防止时间']['unit'] is None
    assert all(rows[name]['line_indexes'] for name in ('V-P转换方式', 'V-P切换应答', '手动背压'))


def test_enum_requires_unique_printed_value_near_anchor():
    lines = [line('手动背压', 100, 100), line('OFF', 100, 135), line('ON', 105, 140),
             line('V-P转换', 100, 200), line('位置', 100, 240, .7)]
    rows = extract_tact5(lines, template(), dict(screen_size=[1000, 700]))['detail']['page_observations']['fields']
    assert not any(row['label'] in ('手动背压', 'V-P转换方式') for row in rows)


def test_named_time_field_is_eligible_for_evidence_based_unit_retry(tmp_path):
    import cv2
    import numpy as np
    from extract_families.tact5_process import recover_time_units
    image = tmp_path/'screen.png'
    cv2.imwrite(str(image), np.full((700, 1000, 3), 255, dtype=np.uint8))
    observation = dict(label='充填过量防止时间', value=0, unit=None, bbox=[600, 300, 650, 320])
    class OCR:
        def ocr(self, crop, cls=False):
            return [[([[45, 30], [60, 30], [60, 60], [45, 60]], ('s', .95))]]
    assert recover_time_units(OCR(), image, [observation], template(), [1000, 700])[0]['text'] == 's'


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


def test_cropped_time_unit_requires_printed_suffix(tmp_path):
    import cv2
    import numpy as np
    from extract_families.tact5_process import recover_time_units

    image = tmp_path/'screen.png'
    cv2.imwrite(str(image), np.full((700, 1000, 3), 255, dtype=np.uint8))
    tpl = template()
    # 射出 value read without its unit (the Z078 gap); glyph evidence is added by rescue.
    lines = sample() + [line('射出', 20, 120), line('3.5', 100, 120)]
    facts = extract_tact5(lines, tpl, dict(screen_size=[1000, 700]))
    rows = {f['label']: f for f in facts['detail']['page_observations']['fields']}
    assert rows['射出']['value'] == 3.5 and rows['射出']['unit'] is None
    assert rows['冷却']['unit'] == 's'  # Embedded unit is not a rescue candidate.
    observations = [rows['射出'], rows['冷却']]

    class Glyph:
        def ocr(self, crop, cls=False):
            # Box in padded (30px) scaled crop coordinates, right of the value edge.
            return [[([[40, 35], [60, 35], [60, 65], [40, 65]], ('S', .95))]]

    extra = recover_time_units(Glyph(), image, observations, tpl, [1000, 700])
    assert [item['text'] for item in extra] == ['s']
    assert extra[0]['bbox']['x_max'] >= rows['射出']['bbox'][2]
    # The rescued line lets the stock unit lookup attach 's' on re-extract.
    facts2 = extract_tact5(lines + extra, tpl, dict(screen_size=[1000, 700]))
    rows2 = {f['label']: f for f in facts2['detail']['page_observations']['fields']}
    assert rows2['射出']['unit'] == 's'
    assert rows2['射出']['line_indexes'][-1] == len(lines)

    class Blank:
        def ocr(self, crop, cls=False):
            return [[]]

    assert recover_time_units(Blank(), image, observations, tpl, [1000, 700]) == []

    class Ambiguous:
        def ocr(self, crop, cls=False):
            return [[([[5, 5], [25, 5], [25, 35], [5, 35]], ('S', .95)),
                     ([[30, 5], [55, 5], [55, 35], [30, 35]], ('5', .9))]]

    assert recover_time_units(Ambiguous(), image, observations, tpl, [1000, 700]) == []
