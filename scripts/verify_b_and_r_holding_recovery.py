"""Export a reproducible before/after report from the real failure photograph.

Uses frozen primary OCR, not a fresh model run. Baseline is f7fd322.
Run: .venv/bin/python scripts/verify_b_and_r_holding_recovery.py
"""
import hashlib
import html
import json
import subprocess
import sys
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from export_page_package import export_page_package
from extract_families.b_and_r_injection import extract_injection_b_and_r
from extract_families.visual_cells import bordered_cells
from rectify import rectify

FIXTURE = ROOT / 'tests/fixtures/b_and_r_holding_recovery'
OUTPUT = ROOT / 'artifacts/br_stability/holding_recovery'
OUTPUT.mkdir(parents=True, exist_ok=True)
frozen = json.loads((FIXTURE / 'ocr.json').read_text())
assert hashlib.sha256((FIXTURE / 'original.jpg').read_bytes()).hexdigest() == frozen['original_sha256']
image = OUTPUT / 'rectified.png'
rectify(FIXTURE / 'original.jpg', image, OUTPUT / 'rectify.json')
template = export_page_package('b_and_r.injection_holding.multi_stage_position_time', '0.1.1')['template']
baseline_layout = {'__package__': 'extract_families'}
baseline_extractor = {'__package__': 'extract_families'}
for filename, namespace in [('b_and_r_layout.py', baseline_layout),
                            ('b_and_r_injection.py', baseline_extractor)]:
    source = subprocess.check_output(['git', 'show', 'f7fd322:scripts/extract_families/'+filename], cwd=ROOT, text=True)
    exec(compile(source, 'f7fd322/'+filename, 'exec'), namespace)
baseline_extractor['physical_rows'] = baseline_layout['physical_rows']
before = baseline_extractor['extract_injection_b_and_r'](frozen['tokens'], template, image)
after = extract_injection_b_and_r(frozen['tokens'], template, image)
assert before['fields']['holding_pressure_bar'] is None
assert after['fields']['holding_pressure_bar'] == [45., 90.]
assert after['fields']['holding_time_s'] == [2., 2.]
assert after['fields']['holding_velocity_pct'] == [6., 10.]
assert after['fields']['injection_velocity_pct'] is None
comparison = dict(mode='frozen_real_primary_ocr_extraction_replay', baseline='f7fd322',
                  source_sha256=frozen['original_sha256'], before=before, after=after,
                  ocr_issues=frozen['ocr_issues'])
(OUTPUT / 'comparison.json').write_text(json.dumps(comparison, ensure_ascii=False, indent=2))
raw = cv2.imread(str(image))
detected = bordered_cells(cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY))
panels = []
predictions = [c for c in after['detail']['holding_layout']['cells'] if not c['observed_border_ids']]
for label, restored in [('BEFORE: detected borders', []),
                        ('AFTER: green = verified logical cell, border unobserved', predictions)]:
    panel = raw.copy()
    for box in detected:
        cv2.rectangle(panel, tuple(box[:2]), tuple(box[2:]), (0, 0, 220), 2)
    for evidence in restored:
        box = evidence['predicted_bbox']
        cv2.rectangle(panel, tuple(box[:2]), tuple(box[2:]), (0, 170, 0), 4)
        cv2.putText(panel, 'logical stage '+str(evidence['stage_id']), (box[0], box[1]-10),
                    cv2.FONT_HERSHEY_SIMPLEX, .6, (0, 130, 0), 2)
    cv2.rectangle(panel, (0, 0), (panel.shape[1], 44), (255, 255, 255), -1)
    cv2.putText(panel, label, (15, 30), cv2.FONT_HERSHEY_SIMPLEX, .75, (0, 0, 0), 2)
    panels.append(panel)
cv2.imwrite(str(OUTPUT / 'reconstruction_evidence.png'), cv2.hconcat(panels))
rows = ''.join('<tr><td>'+html.escape(key)+'</td><td>'+html.escape(str(before['fields'][key]))+
               '</td><td>'+html.escape(str(value))+'</td></tr>' for key, value in after['fields'].items())
proof = html.escape(json.dumps(predictions, ensure_ascii=False, indent=2))
(OUTPUT / 'report.html').write_text('''<!doctype html><meta charset="utf-8"><title>B&amp;R 缺格重建核验</title>
<style>body{font-family:sans-serif;max-width:1500px;margin:30px auto;padding:20px}img{width:100%}
table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:8px}pre{white-space:pre-wrap}</style>
<h1>B&amp;R 保压缺格重建核验</h1><p>真实照片、冻结主 OCR 的提取回放，非重新 OCR，未部署。
基线 f7fd322。红框为公共检测器原始结果，绿框为已验证映射的逻辑格，不能解释成检测到了真实边框。</p>
<img src="reconstruction_evidence.png"><h2>字段前后对照</h2>
<table><tr><th>字段</th><th>修改前</th><th>修改后</th></tr>'''+rows+'''</table>
<h2>重建证据</h2><pre>'''+proof+'''</pre><h2>独立 OCR 问题</h2>
<p>保压速度第1段图上为 5.0，冻结 OCR 为 6.0，仍保留 6.0；射胶速度第2段 70.0 缺读，数组仍为空。
结构恢复不能修正或补造数值。原始读值、可信度和身份验证分别保存在 comparison.json 的 detail 中。
故障注入测试使用真实历史照片，移除或移动检测框，不计为新的真实拍摄样本。</p>
<p><a href="comparison.json">完整字段及证据 JSON</a></p>''')
print(OUTPUT / 'report.html')
print(json.dumps(after['fields'], ensure_ascii=False))
