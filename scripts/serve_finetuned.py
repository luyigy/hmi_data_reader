"""GPU0 BF16 + saved LoRA test service: python -m scripts.serve_finetuned.

POST /infer with raw image bytes; GET / provides a multiple-image upload page.
Localhost only. Results are retained in output/inference-tests/<request id>/.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import threading
import time
from uuid import uuid4
import warnings

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from scripts.train_small_sample import ROOT

RUN = ROOT / 'output/training-prep/bf16-first-20260926-164047'
REPORT = json.loads((RUN / 'report.json').read_text())
OUTPUT = ROOT / 'output/inference-tests'
MAX_BYTES = 20 * 1024 * 1024
MODEL_ID = 'Qwen3.8-27B-BF16-LoRA-20260926'
app = FastAPI(title='HMI 微调模型测试', docs_url=None, redoc_url=None)
model = processor = None
# ponytail: one GPU, one generation at a time; add a queue if concurrent users need it.
lock = threading.Lock()

PAGE = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HMI 微调模型测试</title>
<style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px}
img{max-width:100%;max-height:650px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:16px}
button,input{font:inherit;margin:12px 0}article{border-top:1px solid #ccc;padding-top:20px}</style>
<h1>HMI 微调模型测试</h1>
<p>GPU0 · BF16 底座 + 2026-09-26 adapter。可多选，逐张识别；每张最多 20 MiB。
图片最长边缩至 1024；原图、提示词和原始回答自动保存。输出需人工核对。</p>
<label for="images">选择 HMI 图片：</label><input id="images" type="file" accept="image/*" multiple>
<button id="start">开始识别</button><p id="status" role="status"></p><main id="results"></main>
<script>
const button=document.getElementById('start'), status=document.getElementById('status');
button.onclick=async()=>{
 const files=[...document.getElementById('images').files]; if(!files.length){status.textContent='请先选择图片';return;}
 button.disabled=true;
 try{for(const [i,file] of files.entries()){
  status.textContent=`正在识别 ${i+1}/${files.length}：${file.name}，请等待…`;
  const article=document.createElement('article'), title=document.createElement('h2'), img=document.createElement('img'), pre=document.createElement('pre');
  title.textContent=file.name; img.alt=file.name; const url=URL.createObjectURL(file);img.src=url;img.onload=()=>URL.revokeObjectURL(url);
  article.append(title,img,pre);document.getElementById('results').prepend(article);
  try{
   if(file.size>20*1024*1024)throw Error('图片超过 20 MiB');
   const response=await fetch('/infer',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
   const result=await response.json();if(!response.ok)throw Error(result.detail||response.status);
   pre.textContent=`记录：${result.id} · ${result.seconds} 秒 · ${result.generated_tokens} tokens · JSON 对象：${result.json_valid} · 达到输出上限：${result.truncated}\n\n${result.prediction}`;
  }catch(error){pre.textContent='失败：'+error.message;}
 }status.textContent='本批处理完毕，可以继续选择图片。';}finally{button.disabled=false;}
};
</script></html>'''


@app.get('/', response_class=HTMLResponse)
def index():
    return PAGE


@app.get('/health')
def health():
    return {'ready': model is not None, 'model': MODEL_ID, 'base': REPORT['base_model'],
            'adapter': str(RUN / 'adapter'), 'gpu': 0, 'precision': 'bfloat16', 'busy': lock.locked()}


def infer_image(data):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as source:
                source.load()
                picture = source.convert('RGB')
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        raise HTTPException(422, '无法读取图片或像素尺寸过大') from None
    if model is None:
        raise HTTPException(503, '模型尚未就绪')
    if not lock.acquire(blocking=False):
        raise HTTPException(429, '模型正在处理另一张图片，请稍后重试')
    try:
        import torch

        started = time.monotonic()
        request_id = time.strftime('%Y%m%d-%H%M%S-') + uuid4().hex[:12]
        folder = OUTPUT / request_id
        folder.mkdir(parents=True)
        (folder / 'image.bin').write_bytes(data)
        picture.thumbnail((REPORT['max_image_edge'], REPORT['max_image_edge']))
        messages = [{'role': 'user', 'content': [
            {'type': 'image'}, {'type': 'text', 'text': REPORT['prompt']}]}]
        prompt = processor.apply_chat_template(messages, tokenize=False,
            add_generation_prompt=True, enable_thinking=False)
        inputs = processor(text=[prompt], images=[picture], return_tensors='pt').to('cuda')
        result = dict(id=request_id, model=MODEL_ID, base=REPORT['base_model'],
            adapter=str(RUN / 'adapter'), image_sha256=hashlib.sha256(data).hexdigest(),
            image_size=picture.size, prompt=REPORT['prompt'], max_new_tokens=4096,
            do_sample=False, seed=42)
        (folder / 'request.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        torch.manual_seed(42)
        with torch.inference_mode():
            tokens = model.generate(**inputs, max_new_tokens=4096, do_sample=False, use_cache=True)
        generated = tokens[0, inputs['input_ids'].shape[1]:]
        raw = processor.decode(generated, skip_special_tokens=True)
        try:
            valid = isinstance(json.loads(raw), dict)
        except ValueError:
            valid = False
        result.update(prediction=raw, json_valid=valid, generated_tokens=len(generated),
            truncated=len(generated) >= 4096, seconds=round(time.monotonic() - started, 2))
        (folder / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        return result
    finally:
        lock.release()


@app.post('/infer')
async def infer(request: Request):
    origin = request.headers.get('origin')
    if origin and origin != str(request.base_url).rstrip('/'):
        raise HTTPException(403, '不接受跨站请求')
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, '图片超过 20 MiB')
    return await run_in_threadpool(infer_image, bytes(data))


if __name__ == '__main__':
    assert os.environ.get('CUDA_VISIBLE_DEVICES') == '0', 'Use GPU0 only'
    from unsloth import FastVisionModel
    import torch
    import uvicorn

    assert REPORT['reload_verified'] and REPORT['precision'] == 'bfloat16'
    model, processor = FastVisionModel.from_pretrained(
        str(RUN / 'adapter'), load_in_4bit=False, load_in_8bit=False,
        dtype=torch.bfloat16, max_seq_length=8192, local_files_only=True, device_map={'': 0})
    assert not getattr(model, 'is_loaded_in_4bit', False)
    assert not getattr(model, 'is_loaded_in_8bit', False)
    assert model.peft_config and model.active_adapters
    FastVisionModel.for_inference(model)
    print('READY', health(), flush=True)
    uvicorn.run(app, host='127.0.0.1', port=8005)
