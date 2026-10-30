"""M1 baseline comparison, evidence images and timing (frozen OCR, not blind eval).

Run from the repository root: .venv/bin/python scripts/verify_b_and_r_logical_grid.py
"""
import cProfile
import hashlib
import html
import io
import json
import os
from pathlib import Path
import pstats
from statistics import median
import subprocess
from time import perf_counter

import cv2

from export_page_package import export_page_package
import extract_families.b_and_r_injection as current
from rectify import rectify
from verify_b_and_r_stability import MANIFEST, ROOT, load_sample

OUTPUT = ROOT/'artifacts/br_stability/m1_logical_grid'
OUTPUT.mkdir(parents=True, exist_ok=True)
TEMPLATE = export_page_package('b_and_r.injection_holding.multi_stage_position_time', '0.1.1')['template']
BASELINE = 'cdc3469'
spaces = []
for name in ('b_and_r_layout.py', 'b_and_r_injection.py'):
    namespace = {'__package__': 'extract_families'}
    source = subprocess.check_output(['git', 'show', BASELINE+':scripts/extract_families/'+name], cwd=ROOT, text=True)
    exec(compile(source, BASELINE+'/'+name, 'exec'), namespace)
    spaces.append(namespace)
spaces[1]['physical_rows'] = spaces[0]['physical_rows']
before = spaces[1]['extract_injection_b_and_r']
cases = []
for sample in json.loads(MANIFEST.read_text())['samples']:
    image, tokens, truth = load_sample(sample, OUTPUT)
    cases.append(dict(id=sample['id'], image=image, tokens=tokens, truth=truth, kind='historical_real_frozen_ocr'))
fixture = ROOT/'tests/fixtures/b_and_r_holding_recovery'
for stem, filename, ocr in [('chat_jpeg', 'original.jpg', 'ocr.json'),
                             ('pasted_png', 'pasted_original.png', 'pasted_ocr.json')]:
    frozen = json.loads((fixture/ocr).read_text())
    image = OUTPUT/(stem+'.png')
    assert hashlib.sha256((fixture/filename).read_bytes()).hexdigest() == frozen['original_sha256']
    rectify(fixture/filename, image)
    cases.append(dict(id=stem, image=image, tokens=frozen['tokens'], truth=None,
                      kind='real_input_variant_frozen_primary_ocr'))
records, timings = [], {'baseline': [], 'm1': []}
for case in cases:
    outputs = {}
    for repeat in range(5):
        # Alternate order so neither implementation always gets the warmer run.
        order = [('baseline', before), ('m1', current.extract_injection_b_and_r)]
        for label, run in order if repeat % 2 == 0 else reversed(order):
            started = perf_counter()
            outputs[label] = run(case['tokens'], TEMPLATE, case['image'])
            timings[label].append((perf_counter()-started)*1000)
    old, new = outputs['baseline'], outputs['m1']
    assert old['fields'] == new['fields'], case['id']
    if case['truth'] is not None:
        assert new['fields'] == case['truth'], case['id']
    records.append(dict(id=case['id'], kind=case['kind'], unchanged_fields=True,
                        fields_before=old['fields'], fields_after=new['fields'],
                        layout=new['detail']['holding_layout'], field_results=new['detail']['holding_fields']))
    if case['id'] == 'pasted_png':
        pixels = cv2.imread(str(case['image']))
        for cell in new['detail']['holding_layout']['cells']:
            box = cell['predicted_bbox']
            color = (0, 150, 0) if cell['mapping_status'] == 'verified' else (0, 130, 240)
            cv2.rectangle(pixels, tuple(box[:2]), tuple(box[2:]), color, 2)
            label = cell['row_key']+' '+str(cell['stage_id'])
            cv2.putText(pixels, label, (box[0], box[1]-5), cv2.FONT_HERSHEY_SIMPLEX, .45, color, 1)
        for box in new['detail']['holding_layout']['observed_borders'].values():
            cv2.rectangle(pixels, tuple(box[:2]), tuple(box[2:]), (220, 90, 0), 2)
        cv2.imwrite(str(OUTPUT/'logical_cells.png'), pixels)

# Same image and OCR, controlled detector failures. These are not new photos.
sample = next(c for c in cases if 'rank01' in c['id'])
clean = before(sample['tokens'], TEMPLATE, sample['image'])
grid = clean['detail']['physical_rows']['holding']
detector = current.bordered_cells
detected = detector(cv2.imread(str(sample['image']), 0))
faults = []
for name, remove, shift in [('two_rows_middle', [(1, 1), (2, 1)], False),
                             ('speed_first', [(0, 0)], False),
                             ('whole_pressure', [(1, i) for i in range(3)], False),
                             ('whole_speed', [(0, i) for i in range(4)], False),
                             ('shifted_pressure', [], True)]:
    boxes = [b for b in detected if b not in [grid[r][c] for r, c in remove]]
    if shift:
        target = grid[1][1]
        offset = round((target[2]-target[0])*.5)
        boxes = [[b[0]+offset, b[1], b[2]+offset, b[3]] if b == target else b for b in boxes]
    spaces[1]['bordered_cells'] = lambda gray: boxes
    current.bordered_cells = lambda gray: boxes
    try:
        old = before(sample['tokens'], TEMPLATE, sample['image'])
        new = current.extract_injection_b_and_r(sample['tokens'], TEMPLATE, sample['image'])
    finally:
        current.bordered_cells = detector
        spaces[1]['bordered_cells'] = detector
    wrong = [key for key, value in new['fields'].items() if value is not None and value != clean['fields'][key]]
    assert not wrong, (name, wrong)
    if shift:
        assert new['fields']['holding_pressure_bar'] is None
    else:
        assert new['fields'] == clean['fields']
    faults.append(dict(id=name, kind='detector_fault_injection', fields_before=old['fields'],
                       fields_after=new['fields'], wrong_stage_confirmations=wrong,
                       layout=new['detail']['holding_layout']))

# Profile separately; these traced timings are excluded from the measurements.
profiles = {}
for name, run in [('baseline', before), ('m1', current.extract_injection_b_and_r)]:
    profiler = cProfile.Profile()
    profiler.runcall(run, sample['tokens'], TEMPLATE, sample['image'])
    buffer = io.StringIO()
    pstats.Stats(profiler, stream=buffer).sort_stats('cumtime').print_stats(12)
    profiles[name] = buffer.getvalue()
document = dict(baseline=BASELINE, mode='frozen_real_ocr_extraction_not_end_to_end',
                source_diff_sha256=hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD'], cwd=ROOT)).hexdigest(),
                source_files={f: hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in (
                    'scripts/extract_families/b_and_r_layout.py',
                    'scripts/extract_families/b_and_r_holding_layout.py',
                    'scripts/extract_families/b_and_r_injection.py')},
                real_input_cases=records, detector_faults=faults,
                timing_ms={key: dict(runs=len(values), median=median(values), minimum=min(values), maximum=max(values), samples=values)
                           for key, values in timings.items()},
                environment=dict(cpu_count=os.cpu_count(), load_average=os.getloadavg()), profiles=profiles,
                limitations=['Seven historical photos plus JPEG/PNG variants of one failure scene; no independent blind accuracy estimate.',
                             'Frozen primary OCR replay omits service CLAHE sidecars; preserves OCR 5.0 -> 6.0 and missing 70.0.',
                             'Wrong-stage checks compare frozen readings and stage order, not OCR numeric truth on unknown photos.',
                             'Timing includes image decoding, borders and extraction, excludes fresh OCR, network and Model mapping; noisy shared host.'])
(OUTPUT/'comparison.json').write_text(json.dumps(document, ensure_ascii=False, indent=2))
rows = ''.join('<tr><td>'+html.escape(c['id'])+'</td><td>字段保持一致</td></tr>' for c in records)
fault_rows = ''.join('<tr><td>'+html.escape(c['id'])+'</td><td>'+html.escape(str(c['fields_before']['holding_pressure_bar']))+
                     '</td><td>'+html.escape(str(c['fields_after']['holding_pressure_bar']))+'</td></tr>' for c in faults)
(OUTPUT/'report.html').write_text('''<!doctype html><meta charset="utf-8"><title>B&amp;R M1 逻辑网格验收</title>
<style>body{font-family:sans-serif;max-width:1400px;margin:28px auto;padding:16px}img{max-width:100%}td,th{border:1px solid #aaa;padding:8px}table{border-collapse:collapse}</style>
<h1>B&amp;R M1 逻辑网格验收</h1><p>基线 cdc3469。冻结真实 OCR 提取回放；故障注入不计作新拍摄照片。
绿框是映射已验证的逻辑预测格，蓝框才是检测器返回的实测边框。JSON 分别保存原值、可信度、预测坐标、实测框 ID、段位和读值核验状态。</p>
<img src="logical_cells.png"><h2>真实输入对照</h2><table>'''+rows+'''</table>
<h2>同图检测器故障对照</h2><table><tr><th>场景</th><th>基线保压压力</th><th>M1 保压压力</th></tr>'''+fault_rows+'''</table>
<p>错列继续拒绝相关压力字段，其他安全字段保留。仅预测位置不足以确认字段；OCR 缺读和误读没有通过结构规则修正。</p>
<p>七张历史图的人工真值字段保持一致；两个失败场景图像版本按冻结读数比较，不宣称 OCR 数值全对。
性能测量为同一批输入每侧每图五次交替运行，详见 JSON 的原始样本和独立分析日志，不代表完整线上 OCR 延迟。</p>
<a href="comparison.json">完整对照、布局格、字段状态和性能测量</a>''')
print(json.dumps(dict(real_inputs=len(records), unchanged=len(records), faults=len(faults),
                      wrong_stage_confirmations=0, timing_ms={k: median(v) for k, v in timings.items()}), ensure_ascii=False))
print(OUTPUT/'report.html')
