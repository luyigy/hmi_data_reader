"""Package the visually checked 2026-09-27 answers, without training/GPU work.

Input is the frozen manual field ledger plus the source/leakage audit, NOT the
older OCR-generated draft. Run only after reviewing each field crop.
"""
import hashlib
import json
import os
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/reviews/eval-audit-20260927'
CAT = ROOT / 'datasets/hmi/catalog'
fields = json.loads((OUT/'reviewed-fields.json').read_text())
audit = {e['id']:e for e in map(json.loads,(OUT/'candidates.jsonl').read_text().splitlines())}
raw = {e['sha256'][:16]:e for e in json.loads((ROOT/'datasets/hmi/raw/feishu/20260927/manifest.json').read_text())}
val_ids = ['25c19d6bc0e07b33','2f8331a1e01adab9','abf92d5315a5ffc3','f4f6d483add14cbf','a8b4ad1be62040ec','6824c1f4505b3be9']
test_ids = ['cbbaa2061214175a','bce0f61ea1d72ca4','3548a936b9f28143','05e16b7859f431a9','d2f5c259da3c6a91','5a764c32f60bcaf8','4f47b48701e36305','ee98ed5e237ebde2','7025603dee4e7843']
provisional_ids = []
inventory_path = ROOT/'output/inj_pool_inventory.json'
inventory = json.loads(inventory_path.read_text())['per_machine_with_attachment']
assert inventory['佳明/Z033']['positions'] == ['A10']
assert all(not e['blocked_reasons'] for sid,e in audit.items() if sid in val_ids+test_ids+provisional_ids)
source_aliases = []
for sid, row in audit.items():
    source = row['sources'][0]
    key = source['brand']+'/'+source['machine']
    identity = inventory.get(key)
    source_aliases.append({'id':sid,'machine':source['machine'],'brand':source['brand'], 'source_table':source['base_token']+'/'+source['table_id'], 'legacy_positions':identity.get('positions',[]) if identity else [],'mapping_evidence':str(inventory_path.relative_to(ROOT)) if identity else None,'mapping_status':'historical_table_id_and_position_evidence' if identity else 'unresolved_position_alias','note':'Position alone is not a unique machine; do not merge different Z IDs by position.'})
(OUT/'source-aliases.json').write_text(json.dumps(source_aliases,ensure_ascii=False,indent=2))

manifests = {}
for split, ids in [('val',val_ids),('test',test_ids),('test_pending_identity',provisional_ids)]:
    entries = []
    for sid in ids:
        src = raw[sid]
        row = audit[sid]
        family = 'DEMAG' if src['brand']=='德马格' else ('B_AND_R' if src['brand']=='伯乐' else ('ZIZES' if src['machine']=='Z051' else 'KAIMING'))
        folder = ROOT/'datasets/hmi/annotations/annotation-eval-reviewed-20260927'/sid
        folder.mkdir(parents=True,exist_ok=True)
        original = (ROOT/src['path']).resolve()
        with Image.open(original) as im:
            im.load()
            orientation = im.getexif().get(274,1)
            dimensions = list(im.size)
        link = folder/'image.jpeg'
        if not link.exists():
            link.symlink_to(os.path.relpath(original,folder))
        assert link.resolve()==original
        answer_fields = fields[sid]['fields']
        for key, field in answer_fields.items():
            field['review_status']='agent_visual_verified'
            if key.endswith('启用') or '启用框' in key or '箭头' in key or key=='起始段标识':
                field['kind']='control'
            if field['value'] is None:
                field['null_reason']='disabled_or_blank_per_visible_control_and_existing_user_rulings'
            if src['machine']=='Z051' and '背压' in key:
                field['unit_source']='user_ruling_134_Q5'
        page = src['page']
        if sid in ['f4f6d483add14cbf','a8b4ad1be62040ec']:
            page='工艺优化'
        elif src['brand']=='德马格':
            page='多级注射'
        notes = ['Visible settings and controls checked against native image and every recorded field crop.','Actual values/monitoring rows excluded; blank unused stage cells omitted, visible disabled values retained as null.','Existing Q1-Q7 rulings applied; valid zero delays/mode codes are not blanket-null.']
        if family=='KAIMING':
            notes.append('Stage numbers follow screen headings; dark time row is actual time. Last enabled injection endpoint is separate VP position; last metering endpoint is displayed in the shot-retract position field per accepted layout semantics.')
        if family=='B_AND_R':
            notes.append('Injection/holding stages run right-to-left, metering stages left-to-right. Zero disabled injection slot is null; effective delay and pre-retract zero settings retained consistently with accepted e3143438.')
        annotation = {'id':sid,'image':'image.jpeg','images':[str(original)],'image_sha256':src['sha256'],'image_size':dimensions,'exif_orientation':orientation,'bbox_coordinate_system':'native_pixels_percent_xyxy_no_exif_rotation','machine_id':src['machine'],'controller_family':family,'layout_id':family+'/'+page,'group_id':src['brand']+'/'+src['machine']+'/'+src['mold'],'capture_session':src['date'],'capture_group':row['capture_group'],'recipe_family':row['recipe_family'],'near_duplicate_group':row['visual_group'],'split':split,'status':'agent_visual_verified','reserved_evaluation':True,'reviewed_by':'Codex, source-image and per-field crop review; not additional human confirmation','reviewed_at':'2026-09-27','sources':row['sources'],'provenance':{'audit':'output/reviews/eval-audit-20260927/candidates.jsonl','source_aliases':'output/reviews/eval-audit-20260927/source-aliases.json','historical_machine_exposure':row['historical_machine_evidence'],'direct_exposure':row['direct_exposure'],'isolation_scope':'VLM training-held-out by source machine ID; Z007/Z051 historical CV exposure disclosed; Z006 physical alias unverified' if split=='test' else ('development validation; historical machine exposure disclosed' if split=='val' else 'Z006 physical/legacy alias unresolved; NOT certified blind test')},'review_evidence':{'field_sheet':f'output/reviews/eval-audit-20260927/{sid}-rechecked.jpg','field_sheet_sha256':hashlib.sha256((OUT/f'{sid}-rechecked.jpg').read_bytes()).hexdigest()},'answer':{'schema_version':'1.0','machine_type':src['brand']+' / '+family,'page':page,'fields':answer_fields,'observations':{'source_mold':src['mold'],'review_notes':notes,'semantic_scope':'visible setting values and relevant controls, not monitoring values'},'uncertainties':[]}}
        (folder/'annotation.json').write_text(json.dumps(annotation,ensure_ascii=False,indent=2)+'\n')
        (folder/'answer.json').write_text(json.dumps(annotation['answer'],ensure_ascii=False,indent=2)+'\n')
        entry = {'id':sid,'dir':os.path.relpath(folder.parent,ROOT/'output/training-prep'),'image_sha256':src['sha256'],'annotation_sha256':hashlib.sha256((folder/'annotation.json').read_bytes()).hexdigest(),'answer_sha256':hashlib.sha256((folder/'answer.json').read_bytes()).hexdigest(),'controller_family':family,'machine':annotation['answer']['machine_type'],'machine_id':src['machine'],'group_id':annotation['group_id'],'capture_group':row['capture_group'],'recipe_family':row['recipe_family'],'near_duplicate_group':row['visual_group'],'split':split,'fields':len(answer_fields),'status':'agent_visual_verified','blind_test_eligible':split=='test' and src['machine']=='Z033'}
        entries.append(entry)
    manifests[split]=entries
# The old drafts remain in before/ and their original annotation directories.
for name,split in [('validation','val'),('test','test'),('test-provisional','test_pending_identity')]:
    (CAT/f'{name}-manifest-20260927.json').write_text(json.dumps(manifests[split],ensure_ascii=False,indent=2)+'\n')
lock = {'status':'locked_before_model_evaluation','scope':'9 VLM-held-out images / 4 source machine IDs; historical CV exposure and unresolved Z006 alias retained; not strict zero-history blind test','manifest_sha256':hashlib.sha256((CAT/'test-manifest-20260927.json').read_bytes()).hexdigest(),'entries':manifests['test'],'rule':'Do not tune on these test outputs; any later diagnostic/tuning exposure retires this blind-test version.'}
(CAT/'test-lock-20260927.json').write_text(json.dumps(lock,ensure_ascii=False,indent=2)+'\n')
for old in (ROOT/'datasets/hmi/annotations').glob('annotation-eval-*-20260927/*/annotation.json'):
    if 'annotation-eval-reviewed-' in str(old):
        continue
    a=json.loads(old.read_text())
    a['status']='quarantined_unverified_draft'
    a['review_notes']=[*a.get('review_notes',[]),'2026-09-27 Codex audit: previous human_confirmed claim withdrawn; old answers have leakage/geometry/value errors. Use reviewed catalog only; original bytes preserved in eval-audit-20260927/before/.']
    old.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n')
summary = {k:{'images':len(v),'fields':sum(e['fields'] for e in v)} for k,v in manifests.items()}
(OUT/'delivery-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False))
