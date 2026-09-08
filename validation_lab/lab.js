'use strict';
const $ = id => document.getElementById(id);
const labels = {ready:'可映射',manual:'人工核对',review:'需确认',blocked:'未映射 / 阻断',excluded:'已排除'};
let state, dirty = false, busy = false, targetTextDirty = false;
const el = (tag, text, cls) => { const node=document.createElement(tag); if(text!==undefined)node.textContent=text; if(cls)node.className=cls; return node; };
const msg = (text, error=false) => { $('message').textContent=text; $('message').className=error?'error':''; };
const changed = () => { dirty=true; $('saved').textContent='有未保存修改'; };
async function api(path, options={}) {
  const res=await fetch(path, options);
  if(!res.ok){ const body=await res.json().catch(()=>({})); throw new Error(typeof body.detail==='string'?body.detail:`请求失败 (${res.status})`); }
  return res.json();
}
async function action(fn) {
  if(busy)return;
  busy=true; document.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=true);
  try{ await fn(); }catch(e){msg(e.message,true);}
  finally{busy=false; document.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=false);}
}
function adopt(data) { state=data; dirty=false; targetTextDirty=false; localStorage.setItem('hmi-lab-session',state.session.id); render(); }
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
  $('versions').textContent=JSON.stringify({mapping:p.mapping_version,contract:s.provenance.reader_catalog.contract_version,web_fixture:s.provenance.web_fixture.fixture_version,web_commit:s.provenance.web_fixture.web_commit,local_source:s.provenance.local_source,reader_runtime:s.provenance.reader_runtime,notice:p.notice},null,2);
  $('counts').replaceChildren(...Object.entries(p.counts).map(([k,v])=>el('span',`${labels[k]} ${v}`,'badge '+k)));
  renderPhotos();renderStructure();renderRows();
  $('missing-title').textContent=`尚未覆盖 ${p.missing_targets.length} 个目标字段（不等于这些字段都必须拍摄）`;
  $('missing').replaceChildren(...p.missing_targets.map(t=>el('p',`${t.label} · ${t.unit}`)));
  if(busy)document.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=true);
}
function showEvidence(image) {
  $('evidence-title').textContent=image.filename;
  $('evidence-image').src=`/api/sessions/${state.session.id}/images/${image.id}`;
  $('evidence-json').textContent=JSON.stringify(image.attempts,null,2);
  $('evidence').showModal();
}
function renderPhotos() {
  $('photos').replaceChildren();
  for(const image of state.session.images){
    const card=el('article',undefined,'photo');const photo=el('img');
    photo.src=`/api/sessions/${state.session.id}/images/${image.id}`;photo.alt=image.filename;photo.loading='lazy';
    card.append(photo,el('h3',image.filename));
    const last=image.attempts.at(-1), r=last?.result;
    card.append(el('p',last?.error || (r?`${r.controller_family||'未知控制器'} · ${r.page_type||'未知页面'} · ${r.status||'未知状态'}`:'尚未识别，可点击重试')));
    card.append(el('p',`${r?.profile_status||'未定 profile'} · ${image.attempts.length} 次识别`));
    if(r?.warnings?.length)card.append(el('p',r.warnings.join('；')));
    const target=el('select');target.setAttribute('aria-label',`${image.filename} 模温目标`);
    const empty=el('option','模温照片：请选择目标');empty.value='';target.append(empty);
    for(const z of state.session.target.temperature?.zones||[]){
      if(!['mold_fixed','mold_moving','mold_slide','other'].includes(z.source))continue;
      const option=el('option',z.name||z.zone_id);option.value=z.zone_id;target.append(option);
    }
    target.value=image.mold_target;target.onchange=()=>{image.mold_target=target.value;changed();};card.append(target);
    const exclude=el('label',' 排除此照片');const box=el('input');box.type='checkbox';box.checked=image.excluded;
    box.onchange=()=>{image.excluded=box.checked;changed();};exclude.prepend(box);card.append(exclude);
    const buttons=el('div',undefined,'buttons'),evidence=el('button','查看原图'),retry=el('button','重新识别');
    evidence.onclick=()=>showEvidence(image);retry.onclick=()=>action(async()=>{
      await saveIfDirty();msg('正在重新识别，旧响应仍保留…');
      adopt(await api(`/api/sessions/${state.session.id}/images/${image.id}/recognize`,{method:'POST'}));
      msg('重新识别完成；新结果需重新核对，旧纠错保留在历史中。');
    });buttons.append(evidence,retry);card.append(buttons);$('photos').append(card);
  }
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
  if(!groups.size)$('results').append(el('p','还没有识别字段。添加图片；识别拒绝时可从照片卡片查看 OCR 证据并补拍。'));
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
  const s=state.session;
  if(targetTextDirty){const value=JSON.parse($('target-json').value);s.target=value.parameter_data||value;s.edits={};}
  const images=Object.fromEntries(s.images.map(i=>[i.id,{excluded:i.excluded,mold_target:i.mold_target}]));
  const data=await api(`/api/sessions/${s.id}/review`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:s.revision,target:s.target,edits:s.edits,images,note:$('note').value})});
  adopt(data);msg('纠错已保存，拟写入副本已重新计算。');
}
async function upload(files){
  await saveIfDirty();
  for(let i=0;i<files.length;i++){
    msg(`正在识别 ${i+1}/${files.length}：${files[i].name}，请稍候…`);
    const body=new FormData();body.append('file',files[i]);
    adopt(await api(`/api/sessions/${state.session.id}/images`,{method:'POST',body}));
  }
  msg('照片处理完成。核对识别结果；模温照片请选择目标后重新预览。');await history();
}
$('new').onclick=()=>action(async()=>{await saveIfDirty();adopt(await api('/api/sessions',{method:'POST'}));await history();msg('新批次已创建，可以开始拍照。');});
$('sessions').onchange=()=>action(async()=>{const id=$('sessions').value;if(!id)return;await saveIfDirty();adopt(await api('/api/sessions/'+id));msg('已恢复验证批次。');});
for(const id of ['camera','files'])$(id).onchange=()=>{const files=[...$(id).files];$(id).value='';action(()=>upload(files));};
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
for(const id of ['json','zip'])$(id).onclick=()=>action(async()=>{await saveIfDirty();const a=el('a');a.href=`/api/sessions/${state.session.id}/export?bundle=${id==='zip'}`;a.download='';document.body.append(a);a.click();a.remove();});
$('close-evidence').onclick=()=>$('evidence').close();
window.addEventListener('beforeunload',e=>{if(dirty||busy){e.preventDefault();e.returnValue='';}});
action(async()=>{
  const id=localStorage.getItem('hmi-lab-session');
  if(id){try{adopt(await api('/api/sessions/'+id));}catch(e){if(!e.message.includes('不存在'))throw e;}}
  if(!state)adopt(await api('/api/sessions',{method:'POST'}));
  await history();msg('可以开始拍照。当前目标是空值样例，你可以调整段数或导入参数副本。');
});
