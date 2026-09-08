// Standalone browser check; run only in a stage permitting tests.
// PLAYWRIGHT_MODULE=/path/to/playwright node tests/validation_lab_candidates.browser.js
// Starts an isolated local lab with synthetic Reader responses; never calls a model or Trial.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(__dirname, '..');
const folder = mkdtempSync(join(tmpdir(), 'hmi-s05-'));
const item = (value, label='第 2 段') => ({label,value,sources:['ocr'],evidence:['原图左侧 bbox: 1,2,3,4'],needs_confirmation:true,extra:{keep:true}});
const field = (screen_label, role, value, unit) => ({screen_label,role,unit,canonical_id:null,sources:['ocr'],evidence:['原文证据'],needs_confirmation:true,items:[item(value)]});
const raw = {sections:[{label:'混合参数',fields:[
  field('料筒温度','setpoint',200,'℃'),field('料筒温度','actual',198,'℃'),
  field('目录外转速','setpoint',80,'rpm'),field('射胶速度','setpoint',30,'mm/s'),
  field('保压压力','setpoint',40,'bar'),field('冷却时间','setpoint',12,'s'),field('热流道温度','setpoint',210,'℃'),
]}],questions:['请核对段序，画面可能不完整'],extra_evidence:{keep:'完整保存'}};
const mold = {sections:[{label:'温度',fields:[field('模温','actual',50,'℃')]}],questions:[]};
const server = spawn(join(root,'.venv/bin/python'),['-c',`
import asyncio, json, os, socket, uvicorn
from copy import deepcopy
from fastapi import HTTPException
from validation_lab.app import create_app
from validation_lab.mapping import CATALOG
outcomes = json.loads(os.environ['S05_OUTCOMES'])
outcomes.extend([{'success': True, 'status': 'ok', 'quality': {'triage': 'green'},
    'profile_id': 'demag.temperature.screen_order_5', 'profile_status': 'verified',
    'profile_confidence': .99, 'contract_version': CATALOG['contract_version'],
    'controller_family': 'DEMAG', 'page_type': 'temperature', 'warnings': [],
    'fields': {'barrel_temperature_set_c': [350, 295, 290, 285]}}, outcomes[0], outcomes[0]])
async def reader(*args):
    result = outcomes.pop(0)
    if result is None:
        raise HTTPException(502, 'synthetic retry failure')
    return deepcopy(result)
sock = socket.socket()
sock.bind(('127.0.0.1', 0))
print(sock.getsockname()[1], flush=True)
asyncio.run(uvicorn.Server(uvicorn.Config(create_app(os.environ['S05_DATA'], reader, password=''), log_level='error')).serve(sockets=[sock]))
`],{cwd:root,env:{...process.env,HMI_LAB_PROXY_KEY:'',S05_DATA:folder,S05_OUTCOMES:JSON.stringify([raw,null,{sections:[],questions:['未找到参数']},mold])},stdio:['ignore','pipe','inherit']});
(async()=>{
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{
      let data='';server.stdout.on('data',chunk=>{data+=chunk;if(data.includes('\n'))resolve(Number(data.split('\n')[0]));});
      server.once('error',reject);server.once('exit',code=>reject(new Error(`server exited ${code}`)));
    });
    const url=`http://127.0.0.1:${port}`;
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    // Poll readiness, without hitting any pre-existing lab.
    for(let i=0;;i++){
      try{if((await fetch(url+'/api/config')).ok)break;}catch{}
      if(i===99)throw new Error('Isolated lab did not start');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    await page.goto(url);
    const idle=()=>page.waitForFunction(()=>!document.querySelector('#save').disabled);
    await idle();
    const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=20;return canvas.toDataURL().split(',')[1];});
    await page.locator('#files').setInputFiles({name:'mixed.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await idle();
    const card=page.locator('#candidates article');
    assert.equal(await card.count(),1);
    assert.equal(await page.getByLabel('mixed.png 模温目标').isVisible(),false);
    await page.locator('#photos summary').click();
    assert.equal(await page.getByLabel('mixed.png 模温目标').isVisible(),true);
    await page.locator('#photos summary').click();
    assert.equal(await page.locator('#legacy-preview').isVisible(),false);
    assert.match(await card.innerText(),/目录外参数/);
    assert.match(await card.innerText(),/暂不可映射/);
    assert.match(await card.innerText(),/画面可能不完整/);
    assert.deepEqual(await card.locator('table').first().locator('thead th').allTextContents(),['当前段 / 温区','设定','实际']);
    const value=page.getByLabel('目录外转速 值',{exact:true});
    await value.fill('bad');await page.locator('#save').click();await idle();
    assert.match(await page.locator('#message').innerText(),/有限数字/);
    await value.fill('85');
    await page.getByLabel('mixed.png 确认副本',{exact:true}).click();
    assert.equal(await page.getByLabel('mixed.png 确认副本',{exact:true}).isChecked(),false);
    for(const check of await card.locator('td input[type=checkbox]').all())await check.check();
    await page.getByLabel('mixed.png 确认副本',{exact:true}).check();
    await page.locator('#save').click();await idle();
    await page.reload();await idle();
    assert.equal(await page.getByLabel('目录外转速 值',{exact:true}).inputValue(),'85');
    assert.equal(await page.getByLabel('mixed.png 确认副本',{exact:true}).isChecked(),true);
    assert.match(await card.innerText(),/原值：80 rpm/);
    const sid=await page.locator('#sessions').inputValue();
    const exported=await (await page.request.get(url+`/api/sessions/${sid}/export`)).json();
    assert.deepEqual(exported.candidates[0].result,raw);
    assert.equal(exported.candidates[0].review.attempt,1);
    assert.equal(exported.candidates[0].review.result.sections[0].fields[2].items[0].value,85);
    assert.deepEqual(exported.candidates[0].review.result.extra_evidence,raw.extra_evidence);
    assert.equal(exported.candidates[0].review.confirmed,true);
    assert.deepEqual(exported.preview.rows,[]);
    const download=page.waitForEvent('download');await page.locator('#json').click();
    assert.equal((await download).suggestedFilename(),'hmi-validation.json');
    await page.getByLabel('目录外转速 角色',{exact:true}).fill('actual');
    assert.equal(await page.getByLabel('目录外转速 第 2 段 已核对',{exact:true}).isChecked(),false);
    assert.equal(await page.getByLabel('mixed.png 确认副本',{exact:true}).isChecked(),false);
    await page.locator('#save').click();await idle();
    await page.getByRole('button',{name:'重新识别',exact:true}).click();await idle();
    assert.match(await card.innerText(),/本次重试失败/);
    assert.equal(await page.getByLabel('目录外转速 值',{exact:true}).inputValue(),'85');
    await page.getByRole('button',{name:'重新识别',exact:true}).click();await idle();
    assert.match(await card.innerText(),/空候选/);
    assert.equal(await card.locator('table').count(),0);
    assert.equal(await page.getByLabel('mixed.png 确认副本',{exact:true}).isChecked(),false);
    await page.getByRole('button',{name:'重新识别',exact:true}).click();await idle();
    assert.equal(await page.getByLabel('mixed.png 模温目标').isVisible(),true);
    assert.equal(await page.getByLabel('mixed.png 确认副本',{exact:true}).isChecked(),false);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.getByLabel('模温 角色',{exact:true}).isVisible(),true);
    await page.getByLabel('模温 值',{exact:true}).focus();await page.keyboard.press('Tab');
    assert.equal(await page.getByLabel('模温 段/温区',{exact:true}).evaluate(n=>n===document.activeElement),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'查看原图及原始响应',exact:true}).click();
    assert.equal(await page.locator('#evidence').isVisible(),true);await page.keyboard.press('Escape');
    await page.setViewportSize({width:1280,height:900});
    await page.locator('#new').click();await idle();
    for(const size of [25,26,27]){
      const data=await page.evaluate(size=>{const c=document.createElement('canvas');c.width=c.height=size;return c.toDataURL().split(',')[1];},size);
      await page.locator('#files').setInputFiles({name:`check-${size}.png`,mimeType:'image/png',buffer:Buffer.from(data,'base64')});await idle();
      if(size===25){
        assert.equal(await card.count(),0);
        assert.equal(await page.locator('#legacy-preview').isVisible(),true);
      }
    }
    assert.equal(await card.count(),2);
    assert.equal(await page.locator('#legacy-preview').isVisible(),true);
    await card.nth(0).getByLabel('目录外转速 值',{exact:true}).fill('90');
    await card.nth(1).getByLabel('目录外转速 值',{exact:true}).fill('95');
    let saves=0;
    await page.route('**/review',route=>{
      if(route.request().method()==='PUT' && ++saves===2)
        return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'synthetic second save failure'})});
      return route.continue();
    });
    await page.locator('#save').click();await idle();
    assert.match(await page.locator('#message').innerText(),/synthetic second save failure/);
    assert.equal(await card.nth(1).getByLabel('目录外转速 值',{exact:true}).inputValue(),'95');
    const mixedSid=await page.locator('#sessions').inputValue();
    const partial=await (await page.request.get(url+`/api/sessions/${mixedSid}/export`)).json();
    assert.equal(partial.candidates[0].review.result.sections[0].fields[2].items[0].value,90);
    assert.equal(partial.candidates[1].review,null);
    await page.unroute('**/review');
    await page.locator('#save').click();await idle();await page.reload();await idle();
    assert.equal(await card.nth(0).getByLabel('目录外转速 值',{exact:true}).inputValue(),'90');
    assert.equal(await card.nth(1).getByLabel('目录外转速 值',{exact:true}).inputValue(),'95');
    assert.deepEqual(errors,[]);
    console.log('PASS: candidate UI, confirmation, evidence, export, retry, empty, mold intent, mobile, keyboard, legacy/mixed batches and partial-save recovery');
  }finally{
    if(browser)await browser.close();
    server.kill('SIGTERM');
    if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));
    rmSync(folder,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
