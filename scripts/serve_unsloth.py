"""GPU0-only local OpenAI endpoint for the untrained BNB checkpoint.

Run with /data/venvs/hmi-unsloth/bin/python -m scripts.serve_unsloth.
HTTP, streaming and generation queues are provided by Transformers 5.5.0.
"""
import json
import re
from functools import partial
from unittest.mock import patch

BASE = "/data/cache/modelscope/Qwen/Qwen3.8-27B-unsloth-bnb-4bit"
MODEL = "Qwen3.8-27B-unsloth-bnb-4bit"


def parse_tool_block(block):
    """Qwen3.5 XML arguments; retain the server's older JSON format too."""
    if block.lstrip().startswith("{"):
        value = json.loads(block)
        return value["name"], json.dumps(value.get("arguments", {}))
    match = re.fullmatch(r"\s*<function=([\w.-]+)>(.*?)</function>\s*", block, re.S)
    if not match:
        raise ValueError("Invalid Qwen tool call")
    arguments = {}
    rest = match[2]
    for parameter in re.finditer(r"<parameter=([\w.-]+)>(.*?)</parameter>", match[2], re.S):
        name, value = parameter[1], parameter[2].strip()
        if name in arguments:
            raise ValueError("Duplicate tool parameter")
        # Skill tools take string names and paths; JSON handles structured arguments.
        try:
            arguments[name] = json.loads(value)
        except ValueError:
            arguments[name] = value
        rest = rest.replace(parameter[0], "", 1)
    if rest.strip():
        raise ValueError("Invalid tool parameters")
    return match[1], json.dumps(arguments, ensure_ascii=False)


def validate_chat_request(handler, body):
    from fastapi import HTTPException
    from transformers.cli.serving.utils import BaseHandler

    options = body.pop("chat_template_kwargs", {})
    if (not isinstance(options, dict)
            or set(options) - {"enable_thinking", "preserve_thinking"}
            or options.get("enable_thinking", False) is not False
            or type(options.get("preserve_thinking", True)) is not bool):
        raise HTTPException(422, "This endpoint requires enable_thinking=false")
    BaseHandler._validate_request(handler, body)


def serve_unsloth():
    from unsloth import FastVisionModel
    import torch
    from transformers.cli.serve import Serve
    from transformers.cli.serving.chat_completion import ChatCompletionHandler
    from transformers.cli.serving.model_manager import ModelManager
    from transformers.cli.serving.utils import ToolCallParser

    model, processor = FastVisionModel.from_pretrained(
        BASE, load_in_4bit=True, dtype=torch.bfloat16,
        max_seq_length=32768, local_files_only=True)
    FastVisionModel.for_inference(model)
    processor._tokenizer = processor.tokenizer._tokenizer
    processor.apply_chat_template = partial(processor.apply_chat_template, enable_thinking=False)
    # Process-local adapters: never edit the shared installed packages or weights.
    with patch.object(ModelManager, "_load_model", return_value=model), \
         patch.object(ModelManager, "_load_processor", return_value=processor), \
         patch.object(ModelManager, "get_gen_models", return_value=[
             {"id": MODEL, "object": "model", "owned_by": "local", "root": BASE}]), \
         patch.object(ToolCallParser, "_extract_name_and_args", staticmethod(parse_tool_block)), \
         patch.object(ChatCompletionHandler, "_validate_request", validate_chat_request):
        Serve(force_model=BASE, host="127.0.0.1", port=8004,
              device="cuda:0", dtype="bfloat16", default_seed=42)


if __name__ == "__main__":
    serve_unsloth()
