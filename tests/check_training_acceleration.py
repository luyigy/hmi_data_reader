"""GPU0 kernel checks; pass --image PATH for a disposable multimodal LoRA step."""
import argparse
import os
from importlib.metadata import version

assert os.environ.get("CUDA_VISIBLE_DEVICES") == "0", "Restrict this check to GPU0"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--image")
args = parser.parse_args()

import unsloth
import torch
from causal_conv1d import causal_conv1d_fn
from fla.ops.gated_delta_rule import chunk_gated_delta_rule
from transformers.models.qwen3_5 import modeling_qwen3_5 as qwen
from xformers.ops import memory_efficient_attention

torch.manual_seed(42)
assert torch.cuda.device_count() == 1 and qwen.is_fast_path_available
print({name: version(name) for name in
       ("torch", "triton", "xformers", "causal-conv1d", "unsloth")}, flush=True)
print("FLA:", chunk_gated_delta_rule.__module__, flush=True)

# Check accelerated outputs and gradients against the PyTorch reference.
q, k, v = [torch.randn(1, 128, 4, 128, device="cuda", dtype=torch.bfloat16,
                      requires_grad=True) for _ in range(3)]
g = (-torch.rand(1, 128, 4, device="cuda")).requires_grad_()
beta = torch.rand(1, 128, 4, device="cuda", dtype=torch.bfloat16, requires_grad=True)
out, _ = chunk_gated_delta_rule(q, k, v, g, beta, use_qk_l2norm_in_kernel=True)
ref, _ = qwen.torch_chunk_gated_delta_rule(q, k, v, g, beta, use_qk_l2norm_in_kernel=True)
torch.testing.assert_close(out, ref, atol=2e-3, rtol=3e-2)
grad = torch.randn_like(out)
fast_grads = torch.autograd.grad(out, (q, k, v, g, beta), grad)
ref_grads = torch.autograd.grad(ref, (q, k, v, g, beta), grad)
for actual, expected in zip(fast_grads, ref_grads):
    assert torch.isfinite(actual).all()
    torch.testing.assert_close(actual, expected, atol=3e-2, rtol=5e-2)
print("PASS: FLA forward/backward versus PyTorch", flush=True)

x = torch.randn(1, 128, 128, device="cuda", dtype=torch.bfloat16, requires_grad=True)
w = torch.randn(128, 4, device="cuda", dtype=torch.bfloat16, requires_grad=True)
out = causal_conv1d_fn(x, w, activation="silu")
ref = torch.nn.functional.silu(torch.nn.functional.conv1d(
    x, w.unsqueeze(1), padding=3, groups=128)[..., :128])
torch.testing.assert_close(out, ref, atol=3e-2, rtol=3e-2)
out.float().square().mean().backward()
assert torch.isfinite(x.grad).all() and torch.isfinite(w.grad).all()
out = memory_efficient_attention(q, k, v)
out.float().square().mean().backward()
assert all(t.grad is not None and torch.isfinite(t.grad).all() for t in (q, k, v))
torch.cuda.synchronize()
print("PASS: causal-conv1d and xFormers CUDA forward/backward", flush=True)

if args.image:
    from PIL import Image
    from unsloth import FastVisionModel

    model, processor = FastVisionModel.from_pretrained(
        "/data/cache/modelscope/Qwen/Qwen3.8-27B-unsloth-bnb-4bit",
        load_in_4bit=True, dtype=torch.bfloat16, max_seq_length=2048,
        local_files_only=True,
    )
    model = FastVisionModel.get_peft_model(
        model, r=8, lora_alpha=8, finetune_vision_layers=False,
        finetune_language_layers=True, finetune_attention_modules=True,
        finetune_mlp_modules=True, use_gradient_checkpointing="unsloth",
    )
    FastVisionModel.for_training(model)
    layers = [m for m in model.modules() if hasattr(m, "chunk_gated_delta_rule")]
    assert layers and all(m.causal_conv1d_fn is not None for m in layers)
    assert all("fla" in m.chunk_gated_delta_rule.__module__ for m in layers)
    picture = Image.open(args.image).convert("RGB")
    picture.thumbnail((224, 224))
    messages = [{"role": "user", "content": [
        {"type": "image"}, {"type": "text", "text": "Describe this screen."}]},
        {"role": "assistant", "content": [{"type": "text", "text": "An HMI screen."}]}]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    batch = processor(text=[text], images=[picture], return_tensors="pt").to("cuda")
    labels = batch["input_ids"].clone()
    # This is a synthetic smoke-test target, never a training annotation.
    labels[:, :-8] = -100
    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(params, lr=1e-4)
    loss = model(**batch, labels=labels, use_cache=False).loss
    assert torch.isfinite(loss)
    loss.backward()
    grads = [p for p in params if p.grad is not None]
    assert grads and all(torch.isfinite(p.grad).all() for p in grads)
    changed = next(p for p in grads if p.grad.abs().max() > 0)
    before = changed.detach().clone()
    optimizer.step()
    assert not torch.equal(before, changed)
    torch.cuda.synchronize()
    print("PASS: multimodal LoRA optimizer step; loss=", loss.item(),
          "peak_GiB=", round(torch.cuda.max_memory_allocated() / 2**30, 2), flush=True)
