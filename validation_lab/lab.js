'use strict';
const $ = id => document.getElementById(id);
const labels = {ready:'可映射',manual:'人工核对',review:'需确认',blocked:'未映射 / 阻断',excluded:'已排除'};
let state, dirty = false, busy = false, targetTextDirty = false;
let storageKey, draftEdits = {};
let presets = {};
const labUrl = path => new URL(path.replace(/^\//, ''), new URL('.', document.baseURI)).href;
const el = (tag, text, cls) => { const node=document.createElement(tag); if(text!==undefined)node.textContent=text; if(cls)node.className=cls; return node; };
const msg = (text, error=false) => { $('message').textContent=text; $('message').className=error?'error':''; };
const changed = () => { dirty=true; $('saved').textContent='有未保存修改'; };
async function api(path, options={}) {
  const res=await fetch(labUrl(path), options);
  if(!res.ok){ const body=await res.json().catch(()=>({})); throw new Error(typeof body.detail==='string'?body.detail:`请求失败 (${res.status})`); }
  return res.json();
}
async function action(fn) {
  if(busy)return;
  busy=true; document.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=true);
  try{ await fn(); }catch(e){msg(e.message,true);}
  finally{busy=false; document.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=false);}
}
function adopt(data) { draftEdits={}; state=data; dirty=false; targetTextDirty=false; localStorage.setItem(storageKey,state.session.id); render(); }
async function history() {
  const sessions=await api('/api/sessions'); $('sessions').replaceChildren(el('option','选择批次'));
  $('sessions').firstChild.value='';
  sessions.forEach(s=>{const option=el('option',`${new Date(s.created_at).toLocaleString()} · ${s.id.slice(0,8)}`);option.value=s.id;$('sessions').append(option);});
  if(state)$('sessions').value=state.session.id;
}
function patch(row, values) { state.session.edits[row.id]={...state.session.edits[row.id],...values};changed(); }
function render() {
  const {session:s,preview:p}=state;
  $('batch').textContent=`批次 ${s.id.slice(0,8)} · ${s.images.length}/30 张`;
  $('saved').textContent=`已保存 · 版本 ${s.revision}`;
  $('target-json').value=JSON.stringify(s.target,null,2); $('note').value=s.note;
  $('extraction-request').value=s.extraction_request||'';
  const selected=$('candidate-image').value;
  $('candidate-image').replaceChildren(el('option','全部照片'));
  $('candidate-image').firstChild.value='';
  for(const image of s.images){const option=el('option',image.filename);option.value=image.id;$('candidate-image').append(option);}
  $('candidate-image').value=s.images.some(i=>i.id===selected)?selected:'';
  $('result-summary').textContent=`识别结果：${(state.candidates||[]).length} 张有候选 / ${s.images.length} 张照片 · ${s.images.filter(i=>i.attempts.at(-1)?.error).length} 张识别失败`;
  $('versions').textContent=JSON.stringify({mapping:p.mapping_version,contract:s.provenance.reader_catalog.contract_version,web_fixture:s.provenance.web_fixture.fixture_version,web_commit:s.provenance.web_fixture.web_commit,local_source:s.provenance.local_source,reader_runtime:s.provenance.reader_runtime,notice:p.notice},null,2);
  $('legacy-preview').hidden=!p.rows.length;
  $('legacy-preview').open=!!p.rows.length;
  $('counts').replaceChildren(...Object.entries(p.counts).map(([k,v])=>el('span',`${labels[k]} ${v}`,'badge '+k)));
  renderPhotos();renderStructure();renderCandidates();renderRows();
  $('missing-title').textContent=`尚未覆盖 ${p.missing_targets.length} 个目标字段（不等于这些字段都必须拍摄）`;
  $('missing').replaceChildren(...p.missing_targets.map(t=>el('p',`${t.label} · ${t.unit}`)));
  if(busy)document.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=true);
}
function showEvidence(image) {
  $('evidence-title').textContent=image.filename;
  $('evidence-image').src=labUrl(`/api/sessions/${state.session.id}/images/${image.id}`);
  $('evidence-json').textContent=JSON.stringify(image.attempts,null,2);
  $('evidence').showModal();
}
function renderPhotos() {
  $('photos').replaceChildren();
  for(const image of state.session.images){
    const card=el('article',undefined,'photo');const photo=el('img');
    photo.src=labUrl(`/api/sessions/${state.session.id}/images/${image.id}`);photo.alt=image.filename;photo.loading='lazy';
    card.append(photo,el('h3',image.filename));
    const candidate=(state.candidates||[]).find(c=>c.image_id===image.id);
    const last=image.attempts.at(-1), r=last?.result;
    card.append(el('p',candidate
      ? `参数候选 · 第 ${candidate.attempt} 次有效识别${candidate.last_error?' · 本次重试失败，保留有效候选':''}`
      : last?.error || (r?'旧版识别结果':'尚未识别，可点击重试')));
    if(candidate?.last_error)card.append(el('p',candidate.last_error,'error'));
    card.append(el('p',`${image.attempts.length} 次识别`));
    const targetBox=el('details');targetBox.open=!!image.mold_target||hasMoldCandidate(candidate);
    targetBox.hidden=!targetBox.open && r?.page_type!=='mold_temp';
    targetBox.append(el('summary','模温机目标（可选，仅定模 / 动模 / 行位）'));
    const target=el('select');target.setAttribute('aria-label',`${image.filename} 模温目标`);
    const empty=el('option','模温目标：未选择');empty.value='';target.append(empty);
    for(const z of state.session.target.temperature?.zones||[]){
      if(!['mold_fixed','mold_moving','mold_slide','other'].includes(z.source))continue;
      const option=el('option',z.name||z.zone_id);option.value=z.zone_id;target.append(option);
    }
    target.value=image.mold_target;target.onchange=()=>{image.mold_target=target.value;changed();};
    targetBox.append(target);card.append(targetBox);
    const exclude=el('label',' 排除此照片');const box=el('input');box.type='checkbox';box.checked=image.excluded;
    box.onchange=()=>{image.excluded=box.checked;changed();};exclude.prepend(box);card.append(exclude);
    const buttons=el('div',undefined,'buttons'),evidence=el('button','查看原图'),retry=el('button','重新识别');
    const results=el('button','查看识别结果');
    results.onclick=()=>{$('candidate-image').value=image.id;filterCandidates();$('recognition-results').scrollIntoView();};
    buttons.append(results);
    evidence.onclick=()=>showEvidence(image);retry.onclick=()=>action(async()=>{
      await saveIfDirty();msg('正在重新识别，旧响应仍保留…');
      adopt(await api(`/api/sessions/${state.session.id}/images/${image.id}/recognize`,{method:'POST'}));
      const failure=state.session.images.find(i=>i.id===image.id).attempts.at(-1)?.error;
      msg(failure?`重新识别失败：${failure}；保留上次有效结果，可重试。`:'重新识别完成；新结果需重新核对，旧纠错保留在历史中。',!!failure);
    });buttons.append(evidence,retry);card.append(buttons);$('photos').append(card);
  }
}
function hasMoldCandidate(candidate){
  // ponytail: explicit label hints; extend vocabulary only when real candidates require it.
  return (candidate?.result.sections||[]).some(s=>s.fields.some(f=>
    /模温|模具.*温|mou?ld.*temp|temp.*mou?ld/i.test(`${s.label} ${f.screen_label} ${f.canonical_id||''}`)));
}
function renderCandidates(){
  const root=$('candidates');root.replaceChildren();
  const candidates=state.candidates||[];
  if(!candidates.length)root.append(el('p',state.preview.rows.length
    ? '已有识别参数，见下方展开的结果。点击照片“重新识别”可生成新版参数候选。'
    : '尚无参数候选。请添加图片，或查看照片卡片中的失败原因并重试。'));
  const roles={set:'设定',setpoint:'设定',actual:'实际',limit:'限值',unknown:'角色未知'};
  for(const candidate of candidates){
    const image=state.session.images.find(i=>i.id===candidate.image_id);
    const draft=structuredClone(candidate.review||{attempt:candidate.attempt,result:candidate.result,confirmed:false});
    if(!candidate.review)for(const section of draft.result.sections)for(const field of section.fields){
      field.needs_confirmation=true;field.items.forEach(item=>item.needs_confirmation=true);
    }
    const rawFields=new Map();
    draft.result.sections.forEach((section,si)=>section.fields.forEach((field,fi)=>rawFields.set(field,candidate.result.sections[si]?.fields[fi])));
    const card=el('article');card.dataset.imageId=candidate.image_id;
    card.append(el('h3',`${image.filename} · 第 ${candidate.attempt} 次有效识别`),
      el('p',candidate.notice||'暂不可映射；人工确认不等于业务 safe','badge blocked'));
    if(candidate.excluded)card.append(el('p','此照片已排除；候选与确认副本仍留存。'));
    if(candidate.last_error)card.append(el('p',`本次重试失败：${candidate.last_error}；以下保留上次有效候选。`,'error'));
    const original=el('button','查看原图及原始响应');original.onclick=()=>showEvidence(image);card.append(original);
    const status=el('p'),whole=el('input');whole.type='checkbox';
    const checks=[];
    const sync=()=>{
      whole.checked=draft.confirmed;
      status.textContent=draft.confirmed?'已人工确认副本（不等于业务 safe）':'待人工确认副本';
      checks.forEach(([check,item])=>check.checked=item.needs_confirmation===false);
    };
    const touch=()=>{draft.confirmed=false;draftEdits[candidate.image_id]=draft;changed();sync();};
    const inputFor=(parent,label,value,update)=>{
      const wrap=el('label',label),input=el('input');input.type='text';input.value=value??'';
      input.setAttribute('aria-label',label);input.oninput=()=>{update(input);touch();};
      wrap.append(input);parent.append(wrap);return input;
    };
    card.append(status);
    for(const question of draft.result.questions)card.append(el('p',`待核对 / 不完整：${question}`));
    let count=0;
    for(const section of draft.result.sections){
      card.append(el('h4',section.label));
      // Group only identical screen labels; never infer synonyms or segment order.
      const groups=new Map();
      for(const field of section.fields){
        if(!groups.has(field.screen_label))groups.set(field.screen_label,[]);
        groups.get(field.screen_label).push(field);
      }
      for(const [name,fields] of groups){
        const group=el('div');group.dataset.candidateGroup='';group.append(el('h4',name));card.append(group);
        const table=el('table'),head=el('tr'),thead=el('thead'),body=el('tbody');
        head.append(el('th','当前段 / 温区'));thead.append(head);table.append(thead,body);
        const aligned=new Map();
        fields.forEach((field,col)=>{
          const rawField=rawFields.get(field);
          const header=el('th',roles[field.role]||field.role||'角色未知');header.scope='col';
          const controls=el('div',undefined,'structure');
          controls.append(el('p',`原文：${rawField?.screen_label??'无原始字段'} · ${roles[field.role]||field.role||'角色未知'} · ${field.canonical_id||'目录外参数'}`));
          const invalidate=()=>{field.needs_confirmation=true;field.items.forEach(i=>i.needs_confirmation=true);};
          for(const [key,label] of [['screen_label','参数名'],['unit','单位'],['role','角色']]){
            inputFor(controls,`${name} ${label}`,field[key],input=>{
              field[key]=input.value;header.dataset[{screen_label:'fieldName',unit:'fieldUnit',role:'fieldRole'}[key]]=input.value;invalidate();
            });
          }
          const metadata=el('details');metadata.append(el('summary','原文、来源、证据及全部字段元数据'),el('pre',JSON.stringify(rawField??null,null,2)));controls.append(metadata);group.append(controls);head.append(header);
          for(const node of [controls,header]){
            node.dataset.fieldContext=section.label+' '+(field.canonical_id||'');
            node.dataset.fieldColumn=col;node.dataset.fieldName=name;
            node.dataset.fieldRole=field.role;node.dataset.fieldUnit=field.unit;
          }
          const occurrences=new Map();
          field.items.forEach((item,itemIndex)=>{
            const rawItem=rawField?.items[itemIndex];
            count++;
            const occurrence=occurrences.get(item.label)||0;occurrences.set(item.label,occurrence+1);
            const key=JSON.stringify([item.label??null,occurrence]);
            if(!aligned.has(key))aligned.set(key,{label:item.label??'标量 / 未标段',cells:new Map()});
            const cell=el('td');cell.dataset.label=`${name} · ${roles[field.role]||field.role||'角色未知'}`;
            cell.append(el('small',`原值：${rawItem?.value??'缺值'} ${rawField?.unit||'单位未知'} · 原段/温区：${rawItem?.label??'未标注'}`));
            const value=inputFor(cell,`${name} 值`,item.value,input=>{
              const text=input.value.trim(),number=text===''?null:Number(text);
              const invalid=number!==null&&!Number.isFinite(number);
              input.dataset.invalid=String(invalid);input.setAttribute('aria-invalid',String(invalid));
              input.setCustomValidity(invalid?'请输入有限数字':'');
              if(!invalid)item.value=number;
              item.needs_confirmation=true;field.needs_confirmation=true;
            });value.inputMode='decimal';
            inputFor(cell,`${name} 段/温区`,item.label,input=>{
              item.label=input.value||null;item.needs_confirmation=true;field.needs_confirmation=true;
            });
            const evidence=el('details');evidence.append(el('summary','此项原始证据及额外元数据'),el('pre',JSON.stringify(rawItem??null,null,2)));cell.append(evidence);
            const check=el('input');check.type='checkbox';check.setAttribute('aria-label',`${name} ${item.label??'标量'} 已核对`);
            checks.push([check,item]);
            check.onchange=()=>{
              if(check.checked&&(item.value===null||cell.querySelector('[data-invalid=true]'))){
                check.checked=false;return msg('缺值或非法数值不能确认为已核对，请补充后再确认。',true);
              }
              item.needs_confirmation=!check.checked;
              field.needs_confirmation=field.items.some(i=>i.needs_confirmation!==false);
              touch();
            };
            const label=el('label',' 已核对值、单位、角色、段/温区及证据');label.prepend(check);cell.append(label);
            aligned.get(key).cells.set(col,cell);
          });
        });
        for(const row of aligned.values()){
          const tr=el('tr'),label=el('td',row.label);label.dataset.label='当前段 / 温区';tr.append(label);
          fields.forEach((field,col)=>{const cell=row.cells.get(col)||el('td','此角色无该段候选');cell.dataset.fieldColumn=col;tr.append(cell);});body.append(tr);
        }
        const wrap=el('div',undefined,'table-wrap');wrap.append(table);group.append(wrap);
      }
    }
    if(!count)card.append(el('p','空候选：本次有效响应没有数值参数；请检查原图、补拍或重试。'));
    const full=el('details');full.append(el('summary','完整原始候选（含目录外信息）'),el('pre',JSON.stringify(candidate.result,null,2)));card.append(full);
    whole.setAttribute('aria-label',`${image.filename} 确认副本`);
    whole.onchange=()=>{
      if(whole.checked&&(!count||checks.some(([,item])=>item.needs_confirmation!==false)||card.querySelector('[data-invalid=true]'))){
        whole.checked=false;return msg('请先逐项核对有效参数；空候选不能确认。',true);
      }
      draft.confirmed=whole.checked;draftEdits[candidate.image_id]=draft;changed();sync();
    };
    const confirmLabel=el('label',' 我已核对本图所有候选及问题，确认此独立副本（不等于业务 safe）');confirmLabel.prepend(whole);card.append(confirmLabel);
    sync();root.append(card);
  }
  filterCandidates();
}
function filterCandidates(){
  const scope=$('candidate-filter').value,temperature=scope==='temperature',query=$('candidate-search').value.trim().toLowerCase();
  const pattern=presets[scope]?.pattern;
  const imageId=$('candidate-image').value;
  let total=0,visible=0;
  for(const card of document.querySelectorAll('#candidates article'))card.hidden=!!imageId&&card.dataset.imageId!==imageId;
  for(const group of document.querySelectorAll('[data-candidate-group]')){
    let shown=0;
    for(const header of group.querySelectorAll('th[data-field-column]')){
      const {fieldName:name,fieldRole:role,fieldUnit:unit,fieldColumn:col}=header.dataset;
      const thermal=/温|temp/i.test(name)||/^(℃|°C|°F|摄氏度)$/i.test(unit);
      const match=!group.closest('article').hidden&&name.toLowerCase().includes(query)&&(!temperature||
        (['set','setpoint','actual'].includes(role)&&thermal))&&
        (!pattern||new RegExp(pattern,'i').test(name+' '+header.dataset.fieldContext))&&
        (!['core','thermal'].includes(scope)||(!/偏差|输出|deviation|output/i.test(name)&&(!thermal||['set','setpoint'].includes(role))))&&
        (scope!=='core'||!/周期|开模|合模|顶出|顶退|针阀|干燥|露点|cycle|eject|dry|dew/i.test(name));
      total++;if(match){visible++;shown++;}
      group.querySelectorAll(`[data-field-column="${col}"]`).forEach(node=>node.hidden=!match);
    }
    group.hidden=!shown;
  }
  $('filter-status').textContent=`显示 ${visible} / ${total} 项参数${!visible&&total?'；没有匹配项，可切回全部参数':''}`;
}
function resetValues(node){if(node&&typeof node==='object'){if('raw_value'in node)node.raw_value=null;else Object.values(node).forEach(resetValues);}}
function renderStructure(){
  $('structure').replaceChildren();
  for(const [group,label] of [['plasticizing','熔胶段'],['injection','射出段'],['holding','保压段'],['barrel','射嘴 + 料筒区'],['hot','热嘴']]){
    const s=state.session.target;
    let items=group==='barrel'?(s.temperature?.zones||[]).filter(z=>['nozzle','barrel'].includes(z.source)):group==='hot'?s.cooling_ejection?.hot_runner?.nozzles:s[group]?.segments;
    if(!Array.isArray(items))continue;
    const wrap=el('label',label),input=el('input');input.type='number';input.min=0;input.max=100;input.value=items.length;input.setAttribute('aria-label',label+'数量');
    input.onchange=()=>{
      const n=Number(input.value);
      if(!Number.isInteger(n)||n<0||n>100){input.value=items.length;return msg('数量应在 0–100 之间',true);}
      if(n<items.length&&!confirm('减少数量会删除验证副本中相应段/区及其原值，继续？')){input.value=items.length;return;}
      if(n>items.length&&!items.length){input.value=0;return msg('空结构请从目标 JSON 添加一段/区后再调整数量',true);}
      const next=items.slice(0,n);
      while(next.length<n){const item=structuredClone(items.at(-1));resetValues(item);const i=next.length+1;item.order=i;
        if(group==='barrel'){item.zone_id=`barrel-${i-1}`;item.source='barrel';item.name=`区${i-1}`;}
        else if(group==='hot'){item.nozzle_id=`hot-${i}`;item.name=`热嘴${i}`;}
        else item.segment_id=`${group}-${i}`;
        next.push(item);
      }
      if(group==='barrel')s.temperature.zones=[...next,...s.temperature.zones.filter(z=>!['nozzle','barrel'].includes(z.source))];
      else if(group==='hot')s.cooling_ejection.hot_runner.nozzles=next;
      else s[group].segments=next;
      // Index-addressed corrections must not survive a structure change.
      state.session.edits={};items=next;changed();$('target-json').value=JSON.stringify(s,null,2);
      targetTextDirty=false;
      action(async()=>{await saveIfDirty();msg('目标结构已调整并保存；原逐项确认已清除，请核对新的预览。');});
    };
    wrap.append(input);$('structure').append(wrap);
  }
}
function renderRows(){
  $('results').replaceChildren();
  const groups=Map.groupBy?Map.groupBy(state.preview.rows,r=>r.group):state.preview.rows.reduce((m,r)=>m.set(r.group,[...(m.get(r.group)||[]),r]),new Map());

  for(const [group,rows] of groups){
    $('results').append(el('h3',group,'group-heading'));
    const wrap=el('div',undefined,'table-wrap'),table=el('table'),head=el('tr');
    ['识别字段 / 原值','拟填入值','目标 / before','结果 / 原因','人工核对'].forEach(t=>head.append(el('th',t)));
    const thead=el('thead');thead.append(head);table.append(thead);const tbody=el('tbody');table.append(tbody);
    for(const row of rows){
      const tr=el('tr'),src=el('td',row.label);src.append(el('small',`${JSON.stringify(row.original)} ${row.unit}`));
      const evidence=el('button','原图','evidence-link');evidence.onclick=()=>showEvidence(state.session.images.find(i=>i.id===row.image_id));src.append(evidence);
      const value=el('td'),input=el('input');input.type='number';input.step='any';input.value=typeof row.value==='number'?row.value:'';input.setAttribute('aria-label',row.label+'拟填入值');
      input.onchange=()=>patch(row,{value:input.value===''?null:Number(input.value),confirmed:false});value.append(input,el('small',row.unit));
      const target=el('td'),select=el('select');select.setAttribute('aria-label',row.label+'目标');const empty=el('option','请选择目标');empty.value='';select.append(empty);
      for(const t of state.preview.targets.filter(t=>t.unit===row.unit)){
        const option=el('option',t.label);option.value=t.path;select.append(option);
      }
      select.value=row.target;select.onchange=()=>patch(row,{target:select.value,confirmed:false});target.append(select,el('small',`原值：${row.before??'空'}`),el('small',row.target));
      const status=el('td');status.append(el('span',labels[row.status],'badge '+row.status));row.reasons.forEach(r=>status.append(el('small',r)));
      const manual=el('td'),check=el('input');check.type='checkbox';check.checked=!!state.session.edits[row.id]?.confirmed;check.setAttribute('aria-label',row.label+'已人工核对');
      input.onchange=()=>{check.checked=false;patch(row,{value:input.value===''?null:Number(input.value),confirmed:false});};
      select.onchange=()=>{check.checked=false;patch(row,{target:select.value,confirmed:false});};
      check.onchange=()=>patch(row,{confirmed:check.checked});const confirmLabel=el('label',' 已核对值、段序及语义');confirmLabel.prepend(check);manual.append(confirmLabel);
      const exclude=el('input');exclude.type='checkbox';exclude.checked=row.status==='excluded';exclude.setAttribute('aria-label',row.label+'排除此项');exclude.onchange=()=>patch(row,{excluded:exclude.checked});
      const excludeLabel=el('label',' 排除此项');excludeLabel.prepend(exclude);manual.append(excludeLabel);
      const note=el('input');note.type='text';note.maxLength=1000;note.placeholder='纠错说明';note.value=state.session.edits[row.id]?.note||'';note.setAttribute('aria-label',row.label+'纠错说明');note.onchange=()=>patch(row,{note:note.value});manual.append(note);
      [src,value,target,status,manual].forEach((td,i)=>td.dataset.label=['识别字段 / 原值','拟填入值','目标 / before','结果 / 原因','人工核对'][i]);
      tr.append(src,value,target,status,manual);tbody.append(tr);
    }
    wrap.append(table);$('results').append(wrap);
  }
}
async function saveIfDirty(){
  if(!dirty)return;
  if(document.querySelector('[data-invalid=true]'))throw new Error('候选数值必须是有限数字，空白表示缺值；请先修正无效输入。');
  const s=state.session;
  if(targetTextDirty){const value=JSON.parse($('target-json').value);s.target=value.parameter_data||value;s.edits={};}
  const images=Object.fromEntries(s.images.map(i=>[i.id,{excluded:i.excluded,mold_target:i.mold_target}]));
  // Save per image to stay within the service review limit; keep local edits if a later request fails.
  for(const [iid,draft] of Object.entries(draftEdits)){
    const saved=await api(`/api/sessions/${s.id}/review`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:s.revision,drafts:{[iid]:draft}})});
    s.revision=saved.session.revision;
  }
  const data=await api(`/api/sessions/${s.id}/review`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:s.revision,target:s.target,edits:s.edits,images,note:$('note').value,extraction_request:$('extraction-request').value})});
  adopt(data);msg('纠错与独立确认副本已保存；候选确认不等于业务 safe。');
}
async function upload(files){
  await saveIfDirty();
  for(let i=0;i<files.length;i++){
    msg(`正在识别 ${i+1}/${files.length}：${files[i].name}，请稍候…`);
    const body=new FormData();body.append('file',files[i]);
    adopt(await api(`/api/sessions/${state.session.id}/images`,{method:'POST',body}));
  }
  const failed=state.session.images.filter(i=>i.attempts.at(-1)?.error).length;
  msg(`照片处理完成；本批次 ${failed} 张识别失败。识别结果在“02 · 识别结果”，失败照片可在卡片重试。`,!!failed);
  $('recognition-results').scrollIntoView();await history();
}
$('new').onclick=()=>action(async()=>{await saveIfDirty();adopt(await api('/api/sessions',{method:'POST'}));await history();msg('新批次已创建，可以开始拍照。');});
$('extraction-request').oninput=changed;
$('temperature-request').onclick=()=>{
  $('extraction-request').value='只提取各温区的设定温度和实际温度，不要上下偏差、限制值、输出百分比及其他参数。保留所有温区，不猜测未读清的数值或温区标签。';
  changed();$('candidate-filter').value='temperature';filterCandidates();
  msg('已设置提取要求；已有结果已筛选。点击照片“重新识别”可按此要求重新提取。');
};
$('candidate-filter').onchange=filterCandidates;
$('candidate-image').onchange=filterCandidates;
$('apply-preset').onclick=()=>{
  const scope=$('prompt-preset').value;
  $('extraction-request').value=presets[scope].message;changed();
  $('candidate-filter').value=scope;$('candidate-search').value='';filterCandidates();
  msg('已应用工艺预设并筛选已有结果；新上传或重新识别时使用此要求。');
};
$('candidate-search').oninput=filterCandidates;
$('sessions').onchange=()=>action(async()=>{const id=$('sessions').value;if(!id)return;await saveIfDirty();adopt(await api('/api/sessions/'+id));msg('已恢复验证批次。');});
for(const id of ['camera','files'])$(id).onchange=()=>{const files=[...$(id).files];$(id).value='';action(()=>upload(files));};
const clipboardTypes = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
async function uploadClipboard(blobs){
  if(!blobs.length)throw new Error('剪贴板中没有图片，请先复制截图或图片。');
  if(blobs.some(blob=>!clipboardTypes[blob.type]||blob.size>20*1024*1024))throw new Error('粘贴图片仅支持 JPEG、PNG、WebP，每张最多 20 MiB。');
  const files=blobs.map((blob,i)=>new File([blob],`clipboard-${Date.now()}-${i+1}.${clipboardTypes[blob.type]}`,{type:blob.type}));
  await upload(files);
}
$('paste').onclick=()=>action(async()=>{
  if(!state)throw new Error('批次尚未加载，请刷新后重试。');
  if(!navigator.clipboard?.read){
    throw new Error('浏览器不支持直接读取剪贴板。请点击采集区后按 Ctrl+V / ⌘V 粘贴图片，或使用“添加图片”。');
  }
  let items;
  try{items=await navigator.clipboard.read();}
  catch{
    throw new Error('未能读取剪贴板。请允许剪贴板访问，或点击此按钮后按 Ctrl+V / ⌘V 粘贴图片。');
  }
  const blobs=[];
  for(const item of items){
    const type=item.types.find(type=>clipboardTypes[type]);
    if(type)blobs.push(await item.getType(type));
  }
  await uploadClipboard(blobs);
});
document.addEventListener('paste',event=>{
  if(event.target.closest('input,textarea,[contenteditable]'))return;
  const images=[...(event.clipboardData?.files||[])].filter(file=>file.type.startsWith('image/'));
  if(!images.length)return;
  event.preventDefault();
  if(busy||!state){msg('正在处理，请稍后再粘贴图片。',true);return;}
  action(()=>uploadClipboard(images));
});
$('save').onclick=()=>action(async()=>{changed();await saveIfDirty();});
$('note').oninput=changed;
$('target-json').oninput=()=>{targetTextDirty=true;changed();msg('目标 JSON 有未保存修改；保存时会校验并清除旧的逐项确认。');};
$('apply-target').onclick=()=>action(async()=>{
  targetTextDirty=true;changed();await saveIfDirty();
});
$('target-file').onchange=()=>action(async()=>{
  const file=$('target-file').files[0];if(!file)return;if(file.size>262144)throw new Error('目标 JSON 超过 256 KiB');
  const value=JSON.parse(await file.text());state.session.target=value.parameter_data||value;state.session.edits={};targetTextDirty=false;changed();await saveIfDirty();$('target-file').value='';
});
for(const id of ['json','zip'])$(id).onclick=()=>action(async()=>{await saveIfDirty();const a=el('a');a.href=labUrl(`/api/sessions/${state.session.id}/export?bundle=${id==='zip'}`);a.download='';document.body.append(a);a.click();a.remove();});
$('close-evidence').onclick=()=>$('evidence').close();
window.addEventListener('beforeunload',e=>{if(dirty||busy){e.preventDefault();e.returnValue='';}});
action(async()=>{
  const config=await api('/api/config');
  presets=config.presets;
  for(const [key,preset] of Object.entries(presets)){
    for(const id of ['prompt-preset','candidate-filter']){const option=el('option',preset.label);option.value=key;$(id).append(option);}
  }
  $('candidate-filter').value='core';
  storageKey=`hmi-lab-session:${labUrl('/')}:${config.storage_namespace}`;
  const id=localStorage.getItem(storageKey);
  if(id){try{adopt(await api('/api/sessions/'+id));}catch(e){if(!e.message.includes('不存在'))throw e;}}
  if(!state)adopt(await api('/api/sessions',{method:'POST'}));
  await history();msg('可以开始拍照。先核对参数候选；业务目标副本是可选的。');
});
