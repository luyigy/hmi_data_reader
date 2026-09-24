"""Run with CUDA_VISIBLE_DEVICES=0 /data/venvs/hmi-unsloth/bin/python ..."""
import os

assert os.environ.get("CUDA_VISIBLE_DEVICES") == "0", "Restrict this check to GPU0"

import unsloth
import torch
import bitsandbytes as bnb
from importlib.metadata import version
from transformers import AutoConfig

assert torch.cuda.is_available() and torch.cuda.device_count() == 1
assert torch.cuda.is_bf16_supported()
layer = bnb.nn.Linear4bit(64, 64, compute_dtype=torch.bfloat16, quant_type="nf4").cuda()
x = torch.randn(2, 64, device="cuda", dtype=torch.bfloat16, requires_grad=True)
loss = layer(x).float().square().mean()
loss.backward()
assert torch.isfinite(loss) and torch.isfinite(x.grad).all()
config = AutoConfig.from_pretrained(
    "/data/cache/modelscope/Qwen/Qwen3.8-27B-unsloth-bnb-4bit",
    local_files_only=True,
)
assert config.model_type == "qwen3_5"
print({name: version(name) for name in ("unsloth", "torch", "transformers", "bitsandbytes")})
print("PASS: GPU0, bf16, 4-bit forward/backward, local model config; full model not tested")
