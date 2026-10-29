"""Real historical photos with frozen OCR. Fault injection is labeled separately."""
import copy
import json
import sys
from pathlib import Path

import cv2
import pytest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from verify_b_and_r_stability import MANIFEST, load_sample
from export_page_package import export_page_package
from extract_families.b_and_r_injection import extract_injection_b_and_r
from extract_families.b_and_r_page_observations import _visual_active_count

SAMPLES=json.loads(MANIFEST.read_text())['samples']


@pytest.fixture
def photo(tmp_path):
    sample=next(s for s in SAMPLES if 'rank01' in s['id'])
    image,tokens,truth=load_sample(sample,tmp_path)
    template=export_page_package('b_and_r.injection_holding.multi_stage_position_time','0.1.1')['template']
    return image,tokens,truth,template


@pytest.mark.parametrize('sample',SAMPLES,ids=[s['id'] for s in SAMPLES])
def test_real_photo_values_order_states_and_raw_residuals(sample,tmp_path):
    image,tokens,truth=load_sample(sample,tmp_path)
    template=export_page_package('b_and_r.injection_holding.multi_stage_position_time','0.1.1')['template']
    r=extract_injection_b_and_r(tokens,template,image_path=image)
    assert r['fields']==truth
    assert {s:list(map(len,rows)) for s,rows in r['detail']['physical_rows'].items()}==sample['physical_counts']
    for f in r['detail']['raw_page_observations']['fields']:
        if not f['stage']:
            continue
        verified=f['section']=='injection' or sample['holding_state_verified']
        expected=('enabled' if f['stage']<=truth[f['section']+'_stages'] else 'disabled') if verified else 'unknown'
        assert f['state']==expected
        if expected=='unknown':
            assert f['state_basis'] is None
            assert 'stage_state_unverified' in f['reasons']
        if expected=='disabled':
            assert f['value']==0
    no_image=extract_injection_b_and_r(tokens,template)
    assert all(f['state']=='unknown' for f in no_image['detail']['page_observations']['fields'])


@pytest.mark.parametrize('label,source',[('12.0','injection_velocity_pct'),('115.00','injection_pressure_bar'),('2.00','holding_time_s')])
def test_fault_injection_missing_middle_ocr_does_not_renumber(photo,label,source):
    image,tokens,truth,template=photo
    clean=extract_injection_b_and_r(tokens,template,image_path=image)
    # Select the actual field box, so a same-valued cell in another row is unaffected.
    section='injection' if source.startswith('injection') else 'holding'
    row={'injection_velocity_pct':'velocity','injection_pressure_bar':'pressure','holding_time_s':'time'}[source]
    candidates=[t for t in tokens if t['text']==label]
    if label=='2.00':
        candidates=[t for t in candidates if t['y']>.7]
    target=candidates[0]
    damaged=[t for t in tokens if t is not target]
    result=extract_injection_b_and_r(damaged,template,image_path=image)
    assert result['detail']['raw_rows'][section][row][1] is None
    assert result['detail']['raw_rows'][section][row][2]==clean['detail']['raw_rows'][section][row][2]
    assert result['fields'][source] is None
    # Physical visual evidence must not depend on successful value OCR.
    gray=cv2.imread(str(image),0)
    assert _visual_active_count(clean['detail']['physical_rows'][section][0],gray)==_visual_active_count(result['detail']['physical_rows'][section][0],gray)


def test_fault_injection_whole_ocr_row_missing_keeps_row_identity(photo):
    image,tokens,truth,template=photo
    pressure={'91.00','115.00','100.00'}
    damaged=[t for t in tokens if not(t['text'] in pressure and .47<t['y']<.53)]
    result=extract_injection_b_and_r(damaged,template,image_path=image)
    assert result['detail']['raw_rows']['injection']['pressure']==[None,None,None]
    assert result['detail']['raw_rows']['injection']['position']==truth['injection_position_mm']
    assert result['fields']['injection_stages'] == 3
    assert result['fields']['injection_pressure_bar'] is None


def test_fault_injection_duplicate_value_and_extra_menu_number(photo):
    image,tokens,truth,template=photo
    duplicate=copy.deepcopy(next(t for t in tokens if t['text']=='115.00'))
    duplicate['text']='116.00'
    result=extract_injection_b_and_r(tokens+[duplicate],template,image_path=image)
    assert result['fields']['injection_pressure_bar'] is None
    extra=dict(text='99.0',conf=.99,bbox=[10,985,55,1010],x=.02,y=.5)
    assert extract_injection_b_and_r(tokens+[extra],template,image_path=image)['fields']==truth


def test_fault_injection_missing_rightmost_cell_does_not_invent_stage_one(photo,tmp_path):
    image,tokens,truth,template=photo
    gray=cv2.imread(str(image))
    # Erase stage 1's speed cell but leave its printed header and other rows.
    result=extract_injection_b_and_r(tokens,template,image_path=image)
    x0,y0,x1,y1=result['detail']['physical_rows']['injection'][0][0]
    gray[y0-5:y1+5,x0-5:x1+5]=240
    damaged=tmp_path/'missing-cell.png';cv2.imwrite(str(damaged),gray)
    result=extract_injection_b_and_r(tokens,template,image_path=damaged)
    assert result['fields']['injection_stages'] is None
    assert not any(f['state']=='enabled' and f['section']=='injection' for f in result['detail']['page_observations']['fields'])


def test_fault_injection_malformed_numeric_text_is_not_partially_parsed(photo):
    image,tokens,truth,template=photo
    tokens=copy.deepcopy(tokens)
    target=next(t for t in tokens if t['text']=='12.0')
    target['text']='12O.0'
    result=extract_injection_b_and_r(tokens,template,image_path=image)
    assert result['detail']['raw_rows']['injection']['velocity'][1] is None
    assert result['fields']['injection_velocity_pct'] is None


@pytest.mark.parametrize("text,label", [("12.0", "射胶速度2"), ("5.0", "保压速度1")])
def test_fault_injection_low_confidence_value_remains_unknown(photo,text,label):
    image,tokens,truth,template=photo
    tokens=copy.deepcopy(tokens)
    target=max((t for t in tokens if t['text']==text),key=lambda t:t['x'])
    target['conf']=.3
    result=extract_injection_b_and_r(tokens,template,image_path=image)
    row=next(f for f in result['detail']['page_observations']['fields'] if f['label']==label)
    assert row['value']==float(text)
    assert row['state']=='unknown'
    assert 'stage_state_unverified' in row['reasons']
    assert 'low_confidence' in row['reasons']


def test_registered_and_legacy_entrypoints_keep_real_physical_evidence(photo):
    from extract_fields import extract_page_fields

    image,tokens,truth,template=photo
    legacy=extract_page_fields(tokens,template,image_path=image)
    registered=extract_page_fields(tokens,{**template,'extractor':'registered_extractor',
        'extractor_id':'b_and_r.injection_metering'},image_path=image)
    assert registered==legacy
    assert legacy['fields']==truth
    assert legacy['detail']['physical_rows']['injection']
    assert sum(f['state']=='disabled' for f in legacy['detail']['raw_page_observations']['fields'])==2
    assert not any(f['state']=='disabled' for f in legacy['detail']['page_observations']['fields'])


@pytest.mark.parametrize('scenario',['injection_headers_missing','all_headers_missing','conflicting_header'])
def test_fault_injection_stage_headers_cannot_silently_renumber(photo,scenario):
    image,tokens,truth,template=photo
    tokens=copy.deepcopy(tokens)
    if scenario=='all_headers_missing':
        tokens=[t for t in tokens if t['text'] not in {'1','2','3','4','5'}]
    elif scenario=='injection_headers_missing':
        tokens=[t for t in tokens if not(t['text'] in {'1','2','3','4','5'} and .4<t['y']<.5)]
    else:
        next(t for t in tokens if t['text']=='3' and .4<t['y']<.5)['text']='2'
    result=extract_injection_b_and_r(tokens,template,image_path=image)
    if scenario=='injection_headers_missing':
        assert result['fields']==truth
        assert result['detail']['stage_identity_verified']['injection'] is True
    else:
        assert result['fields']['injection_stages'] is None
        assert not any(f['state']=='enabled' and f['section']=='injection'
                       for f in result['detail']['page_observations']['fields'])
