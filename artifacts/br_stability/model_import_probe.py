"""Read-only Model interpreter check; not an HTTP/package-loader acceptance.

Run with the Model Python and --model-root pointing to its backend directory.
Profile inputs come from the existing pinned document and review overlay. Package
hash loading is deliberately a separate check, not silently claimed by this probe.
"""
import argparse
import copy
import hashlib
import json
import os
import sys
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--model-root',type=Path,required=True)
parser.add_argument('--inputs',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
inputs=json.loads(args.inputs.resolve().read_text());output=args.output.resolve()
model_root=args.model_root.resolve();sys.path.insert(0,str(model_root));os.chdir(model_root)
from app.hmi_mapping.page_profiles import PageProfile
from app.hmi_mapping.reader_observations import import_observations

pid='b_and_r.injection_holding.multi_stage_position_time'
package_path=model_root/'app/hmi_mapping/page_packages'/f'{pid}-0.1.2.json'
lock_path=model_root/'app/hmi_mapping/accepted_packages'/f'{pid}.lock.json'
package=json.loads(package_path.read_text());lock=json.loads(lock_path.read_text())
candidate={k:v for k,v in package['template']['business_profile_candidate'].items() if k in PageProfile.model_fields}
candidate.update(lock.get('candidate_overlay',{}));candidate.update(lock['versions']['0.1.2'].get('candidate_overlay',{}));candidate['package_version']='0.1.2'
profile=PageProfile.model_validate(candidate)
results=[]
for item in inputs:
 for mode in ('fixed','all_stages_unknown','one_holding_speed_low_confidence'):
  facts=copy.deepcopy(item['page_observations'])
  if mode=='all_stages_unknown':
   facts['visual_stage_counts']={}
   for field in facts['fields']:
    if field['stage']:
     field['state']='unknown';field['state_basis']=None;field['reasons'].append('stage_state_unverified')
  if mode=='one_holding_speed_low_confidence':
   field=next(f for f in facts['fields'] if f['label']=='保压速度1')
   field['state']='unknown';field['confidence']=.3;field['reasons'].append('low_confidence')
  record=dict(answer=dict(fields={},segments={},uncertainties=[]),screen=dict(fields={}),ocr_result=dict(fields=item['fields'],page_observations=facts))
  import_observations(record,profile,pid)
  fields=[]
  for f in record['screen']['fields'].values():
   source=f['reader_observation'];field=dict(label=f['label_text'],stage=source['stage'],state=source['state'],auto_preselect=f['auto_preselect'],target_slot=f['target_slot'])
   fields.append(field)
   if source['stage'] and source['state']=='unknown': assert f['auto_preselect'] is False
   if source['stage'] and source['state']=='enabled': assert f['auto_preselect'] is True, field
  results.append(dict(sample=item['sample'],mode=mode,fields=fields))
paths=[package_path,lock_path,model_root/'app/hmi_mapping/reader_observations.py',model_root/'app/integrations/hmi_page_observations.py']
output.write_text(json.dumps(dict(scope='Existing Model import function and pinned profile inputs only; does not certify package loader or UI persistence.',source_hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},results=results),ensure_ascii=False,indent=2))
print(json.dumps(dict(samples=len(inputs),scenarios=len(results),stage_unknown_preselection_rejected=True,enabled_fields_still_preselected=True)))
