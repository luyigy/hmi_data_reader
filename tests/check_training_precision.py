"""GPU0 regression: loss -> generation -> next image -> backward; no saved weights.

CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  /data/venvs/hmi-unsloth/bin/python -m tests.check_training_precision
"""
import os

assert os.environ.get("CUDA_VISIBLE_DEVICES") == "0", "Use GPU0 only"

import unsloth
import torch
from PIL import Image
from unsloth import FastVisionModel
from scripts.train_small_sample import BASE, PROMPT, model_loss, read_samples

torch.manual_seed(42)
model, processor = FastVisionModel.from_pretrained(
    BASE, load_in_4bit=True, dtype=torch.bfloat16, max_seq_length=8192,
    local_files_only=True,
)
model = FastVisionModel.get_peft_model(
    model, r=8, lora_alpha=8, finetune_vision_layers=False,
    finetune_language_layers=True, finetune_attention_modules=True,
    finetune_mlp_modules=True, use_gradient_checkpointing="unsloth",
)
FastVisionModel.for_inference(model)
for row in read_samples():
    picture = Image.open(row["image"]).convert("RGB")
    picture.thumbnail((1024, 1024))
    prompt = processor.apply_chat_template(
        [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": PROMPT}]}],
        tokenize=False, add_generation_prompt=True, enable_thinking=False,
    )
    inputs = processor(text=[prompt], images=[picture], return_tensors="pt").to("cuda")
    batch = processor(text=[prompt + "{}" + processor.tokenizer.eos_token],
                      images=[picture], return_tensors="pt")
    batch["labels"] = batch["input_ids"].clone()
    batch["labels"][:, :inputs["input_ids"].shape[1]] = -100
    with torch.no_grad():
        loss = model_loss(model, batch)
        assert torch.isfinite(loss)
        model.generate(**inputs, max_new_tokens=8, do_sample=False, use_cache=True)
        repeated = model_loss(model, batch)
        assert torch.isfinite(repeated)
    assert batch["input_ids"].dtype == batch["labels"].dtype == torch.int64
    print("PASS: loss/generate/loss", row["id"], loss.item(), repeated.item(), flush=True)

FastVisionModel.for_training(model)
loss = model_loss(model, batch)
assert torch.isfinite(loss)
loss.backward()
grads = [p.grad for p in model.parameters() if p.requires_grad and p.grad is not None]
assert grads and all(torch.isfinite(g).all() for g in grads)
assert any(g.abs().max() > 0 for g in grads)
print("PASS: finite nonzero LoRA gradients after evaluation/generation; no optimizer step or save", flush=True)
