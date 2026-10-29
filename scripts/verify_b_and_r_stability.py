"""Replay frozen OCR and original B&R photographs; export field-level evidence.

Run: .venv/bin/python scripts/verify_b_and_r_stability.py --output artifacts/br_stability
This evaluates extraction, not the OCR model itself or Model-side preselection.
"""
import argparse
import copy
import csv
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

from export_page_package import export_page_package
from extract_families.b_and_r_injection import extract_injection_b_and_r
from extract_families.b_and_r_page_observations import ROWS
from extract_families.coordinates import project_boxes
from extract_families.visual_cells import cell_glyph_evidence
from rectify import warp_to_screen

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'tests/fixtures/b_and_r_stability/manifest.json'


def load_sample(sample, output):
    original = ROOT / sample['original']
    if hashlib.sha256(original.read_bytes()).hexdigest() != sample['original_sha256']:
        raise ValueError('Original photo hash mismatch: ' + sample['id'])
    frozen = json.loads((ROOT/sample['fixture']).read_text())
    meta = frozen['rectify']
    image, size = warp_to_screen(cv2.imread(str(original)), np.array(meta['screen_quad'], np.float32), 2000)
    target = output / (sample['id']+'.png')
    cv2.imwrite(str(target), image)
    if hashlib.sha256(target.read_bytes()).hexdigest() != sample['rectified_sha256']:
        raise ValueError('Rectification replay mismatch: ' + sample['id'])
    w, h = size
    tokens = []
    for index, line in enumerate(frozen['lines']):
        box = [line['bbox'][key] for key in ('x_min','y_min','x_max','y_max')]
        tokens.append(dict(text=line['text'], bbox=box, conf=line.get('conf', 0),
                           x=(box[0]+box[2])/2/w, y=(box[1]+box[3])/2/h, line_index=index))
    return target, tokens, json.loads((ROOT/sample['truth']).read_text())['fields']


def verify(output):
    output.mkdir(parents=True, exist_ok=True)
    template = export_page_package('b_and_r.injection_holding.multi_stage_position_time','0.1.1')['template']
    results, matrix, model_inputs = [], [], []
    for sample in json.loads(MANIFEST.read_text())['samples']:
        image, tokens, truth = load_sample(sample, output)
        result = extract_injection_b_and_r(tokens, template, image_path=image)
        detail = result['detail']
        facts = copy.deepcopy(detail['page_observations'])
        meta = json.loads((ROOT/sample['fixture']).read_text())['rectify']
        project_boxes(facts['fields'], meta)
        model_inputs.append(dict(sample=sample['id'], fields=result['fields'], page_observations=facts))
        gray = cv2.imread(str(image), 0)
        for prefix, source in ROWS.items():
            section, name = prefix.split('.')
            raw_name = {'speed':'velocity','pressure':'pressure','end':'position','time':'time'}[name]
            values = truth[source] + ([0.0] if name == 'speed' else [])
            observed = {f['stage']: f for f in detail['raw_page_observations']['fields']
                        if f['label'].startswith(template['business_profile_candidate']['possible_names'][prefix+'.{n}'][0].split('{n}')[0])}
            for stage, expected in enumerate(values, 1):
                field = observed.get(stage, {})
                expected_state = 'disabled' if stage > truth[section+'_stages'] else 'enabled'
                matrix.append(dict(sample=sample['id'],field=prefix+'.'+str(stage),expected=expected,
                                   actual=field.get('value'),value_ok=field.get('value')==expected,
                                   expected_state=expected_state,state=field.get('state'),
                                   state_verified=field.get('state')==expected_state,
                                   bbox=field.get('bbox')))
        diagnostics = {}
        for section, rows in detail['physical_rows'].items():
            diagnostics[section] = dict(physical_counts=list(map(len,rows)),
                speed_evidence=[cell_glyph_evidence(gray, b) for b in rows[0]],
                raw_values=detail['raw_rows'][section])
        results.append(dict(sample=sample['id'],numeric_groups_match=result['fields']==truth,
                            diagnostics=diagnostics,result=result))
    (output/'matrix.json').write_text(json.dumps(matrix,ensure_ascii=False,indent=2))
    (output/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
    (output/'model-inputs.json').write_text(json.dumps(model_inputs,ensure_ascii=False,indent=2))
    with (output/'matrix.csv').open('w') as stream:
        writer = csv.DictWriter(stream, fieldnames=matrix[0].keys(), lineterminator="\n");writer.writeheader();writer.writerows(matrix)
    print(json.dumps(dict(samples=len(results),numeric_groups_match=sum(r['numeric_groups_match'] for r in results),
                          physical_values=len(matrix),value_matches=sum(r['value_ok'] for r in matrix),
                          verified_states=sum(r['state_verified'] for r in matrix),
                          unknown_states=sum(r['state']=='unknown' for r in matrix))))
    return results, matrix


if __name__ == '__main__':
    parser = argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    verify(parser.parse_args().output)
