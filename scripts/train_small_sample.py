"""Isolated small-sample draft-label experiment; never a held-out accuracy test.

CLI defaults to the reviewed 65-image training-manifest-20260927-tact5.json.
Vision and language LoRA are trained; base weights stay frozen.
read_samples() without an argument retains the historical manifest for old checks.

CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  /data/venvs/hmi-unsloth/bin/python -u -m scripts.train_small_sample --output OUTPUT
Run from the repository root with -m so scripts/datasets.py cannot shadow Hugging Face datasets.
Repeat with --phase reload to verify the saved adapter in a fresh process.
Use --round2 for six epochs with held-out validation selection; then reload and test separately.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import time

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "output/training-prep/confirmed-manifest.json"
RESERVED = ROOT / "output/training-prep/reserved-manifest.json"
BASE = "/data/cache/modelscope/Qwen/Qwen3.8-27B"
PROMPT = (
    "读取这张注塑机HMI图片中的射出、保压、计量、冷却、减压与V-P转换设定。"
    "只输出JSON，键为schema_version（1.0）、machine_type、page、fields、observations、uncertainties。"
    "fields用区域/原标签作键，每项包含value、unit、kind（other）、unit_source、bbox（原图百分比xyxy）。"
    "observations包含layout、order、holding_time、position。保留有效零值，排除监视值和禁用段残留值。"
    "先识别品牌、控制器布局与页面，再按各区域标签、段号和启用状态解释字段。"
    "区分设定值、实际值和推导值；仅在布局规则及所需输入明确时推导，说明依据，缺失或歧义记未知。"
)


def read_samples(manifest=None):
    rows = []
    reserved = {r["image_sha256"] for r in json.loads(RESERVED.read_text())}
    assert reserved, "Reserved evaluation manifest is empty"
    entries = json.loads((manifest or MANIFEST).read_text())
    assert entries, "confirmed-manifest.json is empty"
    for entry in entries:
        folder = ROOT / "output/training-prep" / entry["dir"] / entry["id"]
        source = folder / "annotation.json"
        row = json.loads(source.read_text())
        picture = folder / row["image"]
        assert row["id"] == entry["id"] and row["status"] == "human_confirmed"
        assert not row["reserved_evaluation"]
        assert row["split"] not in ("test", "validation")
        assert hashlib.sha256(picture.read_bytes()).hexdigest() == row["image_sha256"] == entry["image_sha256"]
        if row["image_sha256"] in reserved:
            print("EXCLUDE reserved evaluation image:", row["id"], flush=True)
            continue
        assert row["answer"] and row["answer"]["fields"]
        for field in row["answer"]["fields"].values():
            box = field.get("bbox")
            if box is not None:
                x1, y1, x2, y2 = box
                assert 0 <= x1 < x2 <= 100 and 0 <= y1 < y2 <= 100
        rows.append(dict(id=row["id"], image=str(picture), image_sha256=row["image_sha256"],
            annotation_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
            status=row["status"], answer=row["answer"], review_notes=row["review_notes"]))
    assert rows and len({r["image_sha256"] for r in rows}) == len(rows)
    return rows


def model_loss(model, batch):
    import torch

    # Match generate()'s mixed precision, including forwards after generation.
    with torch.autocast("cuda", dtype=torch.bfloat16):
        return model(**batch.to("cuda"), use_cache=False).loss


def read_evaluation(name, training):
    """Verify frozen evaluation assets without adding them to optimizer batches."""
    catalog = ROOT / "datasets/hmi/catalog"
    manifest = catalog / f"{name}-manifest-20260927.json"
    entries = json.loads(manifest.read_text())
    assert entries
    if name == "test":
        lock = json.loads((catalog / "test-lock-20260927.json").read_text())
        assert lock["manifest_sha256"] == hashlib.sha256(manifest.read_bytes()).hexdigest()
        assert lock["entries"] == entries
    seen = {r["image_sha256"] for r in training}
    rows = []
    for entry in entries:
        folder = ROOT / "output/training-prep" / entry["dir"] / entry["id"]
        source = folder / "annotation.json"
        row = json.loads(source.read_text())
        picture = folder / row["image"]
        assert hashlib.sha256(source.read_bytes()).hexdigest() == entry["annotation_sha256"]
        assert hashlib.sha256((folder / "answer.json").read_bytes()).hexdigest() == entry["answer_sha256"]
        assert json.loads((folder / "answer.json").read_text()) == row["answer"]
        digest = hashlib.sha256(picture.read_bytes()).hexdigest()
        assert digest == row["image_sha256"] == entry["image_sha256"] and digest not in seen
        seen.add(digest)
        assert row["id"] == entry["id"] and row["reserved_evaluation"] is True
        assert row["split"] == ("val" if name == "validation" else "test")
        assert row["status"] == "agent_visual_verified" and row["answer"]["fields"]
        rows.append(dict(id=row["id"], image=str(picture), image_sha256=digest,
            annotation_sha256=entry["annotation_sha256"], answer=row["answer"]))
    return rows


def field_metrics(response, expected):
    try:
        predicted = json.loads(response)
    except (ValueError, TypeError):
        predicted = None
    fields = predicted.get("fields") if isinstance(predicted, dict) else None
    valid = isinstance(fields, dict)
    fields = fields if valid else {}
    correct = sum(isinstance(fields.get(k), dict) and fields[k].get("value") == v["value"]
        and fields[k].get("unit") == v["unit"] for k, v in expected.items())
    missing = sorted(set(expected) - set(fields))
    extra = sorted(set(fields) - set(expected))
    return dict(json_valid=valid, value_unit_correct=correct, expected_fields=len(expected),
        predicted_fields=len(fields), missing_fields=missing, extra_fields=extra,
        wrong_value_unit=len(expected) - len(missing) - correct,
        exact_page=valid and correct == len(expected) and not extra)


def summarize_fields(results):
    correct = sum(r["value_unit_correct"] for r in results)
    expected = sum(r["expected_fields"] for r in results)
    predicted = sum(r["predicted_fields"] for r in results)
    return dict(correct=correct, expected=expected, predicted=predicted,
        precision=correct / predicted if predicted else 0,
        recall=correct / expected if expected else 0,
        f1=2 * correct / (expected + predicted) if expected + predicted else 0,
        exact_pages=sum(r["exact_page"] for r in results), samples=len(results),
        invalid_json=sum(not r["json_valid"] for r in results),
        missing=sum(len(r["missing_fields"]) for r in results),
        extra=sum(len(r["extra_fields"]) for r in results),
        wrong_value_unit=sum(r["wrong_value_unit"] for r in results))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--phase", choices=("train", "reload", "test"), default="train")
    parser.add_argument("--round2", action="store_true", help="Validate each epoch and save the best field-F1 adapter")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--epochs", type=int)
    parser.add_argument("--smoke", action="store_true", help="One update on each of the two longest complete samples; short generation")
    parser.add_argument("--manifest", type=Path, default=ROOT / "datasets/hmi/catalog/training-manifest-20260927-tact5.json")
    args = parser.parse_args()
    args.epochs = args.epochs if args.epochs is not None else (6 if args.round2 else 3)
    rows = read_samples(args.manifest)
    validation = read_evaluation("validation", rows) if args.round2 else []
    testing = read_evaluation("test", rows + validation) if args.round2 else []
    assert args.phase != "test" or args.round2, "Test requires --round2"
    assert not (args.round2 and args.smoke), "Keep smoke and formal validation in separate runs"
    assert args.epochs > 0
    if args.check:
        print(f"PASS: {len(rows)} distinct non-reserved images, hashes, answers and bboxes")
        if args.round2:
            print(f"PASS: validation={len(validation)}, test={len(testing)}; frozen hashes, disjoint images, test lock")
        return
    assert os.environ.get("CUDA_VISIBLE_DEVICES") == "0", "Use GPU0 only"
    out = args.output.resolve()
    if args.phase == "train":
        out.mkdir(parents=True, exist_ok=False)
        (out / "samples.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
        (out / "reserved-manifest.json").write_text(RESERVED.read_text())
        if args.round2:
            (out / "evaluation-samples.json").write_text(json.dumps(dict(validation=validation, test=testing), ensure_ascii=False, indent=2))
    else:
        assert rows == json.loads((out / "samples.json").read_text()), "Source changed since training"
        report = json.loads((out / "report.json").read_text())
        assert report["smoke"] == args.smoke, "Reload must use the same --smoke setting"
        assert report["base_model"] == BASE and report["precision"] == "bfloat16"
        assert report.get("round2", False) == args.round2
        if args.round2:
            assert json.loads((out / "evaluation-samples.json").read_text()) == dict(validation=validation, test=testing)
        if args.phase == "test":
            assert report["reload_verified"], "Reload verification must pass before test"
            assert not (out / "test.json").exists(), "Test already attempted; do not silently repeat or tune against it"

    import unsloth
    import torch
    from PIL import Image
    from unsloth import FastVisionModel

    started = time.monotonic()
    assert torch.cuda.device_count() == 1 and torch.cuda.is_bf16_supported()
    free, total = torch.cuda.mem_get_info()
    print("GPU0", dict(free_GiB=free/2**30, total_GiB=total/2**30), flush=True)
    assert free >= 72 * 2**30, "GPU0 needs at least 72 GiB free for this BF16 experiment"
    torch.manual_seed(42)
    model, processor = FastVisionModel.from_pretrained(
        str(out / "adapter") if args.phase != "train" else BASE,
        load_in_4bit=False, load_in_8bit=False, dtype=torch.bfloat16, max_seq_length=8192,
        local_files_only=True, device_map={"": 0},
    )
    assert not getattr(model, "is_loaded_in_4bit", False)
    assert not getattr(model, "is_loaded_in_8bit", False)
    print("LOADED BF16", dict(allocated_GiB=torch.cuda.memory_allocated()/2**30), flush=True)
    if args.phase == "train":
        model = FastVisionModel.get_peft_model(
            model, r=8, lora_alpha=8, finetune_vision_layers=True,
            finetune_language_layers=True, finetune_attention_modules=True,
            finetune_mlp_modules=True, use_gradient_checkpointing="unsloth",
        )

    batches, prompts = [], []
    evaluation_rows = testing if args.phase == "test" else validation
    for row in rows + evaluation_rows:
        picture = Image.open(row["image"]).convert("RGB")
        picture.thumbnail((1024, 1024))
        messages = [{"role": "user", "content": [
            {"type": "image"}, {"type": "text", "text": PROMPT}]}]
        prompt = processor.apply_chat_template(messages, tokenize=False,
            add_generation_prompt=True, enable_thinking=False)
        answer = json.dumps(row["answer"], ensure_ascii=False, separators=(",", ":"))
        full = prompt + answer + processor.tokenizer.eos_token
        inputs = processor(text=[prompt], images=[picture], return_tensors="pt")
        batch = processor(text=[full], images=[picture], return_tensors="pt")
        n = inputs["input_ids"].shape[1]
        assert torch.equal(inputs["input_ids"], batch["input_ids"][:, :n]), "Prompt/answer boundary mismatch"
        labels = batch["input_ids"].clone()
        labels[:, :n] = -100
        assert (labels != -100).sum() > 0 and labels.shape[1] <= 8192
        batch["labels"] = labels
        batches.append(batch)
        prompts.append(inputs)
        print(json.dumps(dict(id=row["id"], size=picture.size, tokens=labels.shape[1],
            answer_tokens=int((labels != -100).sum()))), flush=True)

    evaluation_batches, evaluation_prompts = batches[len(rows):], prompts[len(rows):]
    batches, prompts = batches[:len(rows)], prompts[:len(rows)]

    if args.smoke:
        selected = sorted(range(len(rows)), key=lambda i: batches[i]["input_ids"].shape[1], reverse=True)[:2]
        rows, batches, prompts = ([items[i] for i in selected] for items in (rows, batches, prompts))
        args.epochs = 1
        print("SMOKE longest full samples:", [r["id"] for r in rows], flush=True)

    def evaluate(stage, generate=True, held_out=False):
        FastVisionModel.for_inference(model)
        results = []
        data = (evaluation_rows, evaluation_batches, evaluation_prompts) if held_out else (rows, batches, prompts)
        for row, batch, inputs in zip(*data):
            with torch.no_grad():
                loss = model_loss(model, batch).item()
                assert torch.isfinite(torch.tensor(loss))
                result = dict(id=row["id"], loss=loss)
                if generate:
                    tokens = model.generate(**inputs.to("cuda"), max_new_tokens=8 if args.smoke else 4096,
                        do_sample=False, use_cache=True)
                    response = processor.decode(tokens[0, inputs["input_ids"].shape[1]:], skip_special_tokens=True)
                    result["prediction"] = response
                    result.update(field_metrics(response, row["answer"]["fields"]))
                    result["generated_tokens"] = tokens.shape[1] - inputs["input_ids"].shape[1]
                    result["hit_token_limit"] = result["generated_tokens"] >= (8 if args.smoke else 4096)
            results.append(result)
            (out / f"{stage}.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
            print(stage, json.dumps({k: v for k, v in result.items() if k != "prediction"}), flush=True)
        return results

    if args.phase == "test":
        results = evaluate("test", held_out=True)
        (out / "test-summary.json").write_text(json.dumps(summarize_fields(results), indent=2))
        print("PASS: locked test evaluated; historical exposure caveats still apply", flush=True)
        return

    if args.phase == "reload":
        results = evaluate("reload", generate=False)
        previous = json.loads((out / "after.json").read_text())
        assert [r["id"] for r in results] == [r["id"] for r in previous]
        for actual, expected in zip(results, previous):
            assert abs(actual["loss"] - expected["loss"]) < 0.01, "Reload changed model loss"
        (out / "reload-check.json").write_text(json.dumps(dict(passed=True, samples=len(rows),
            tolerance=0.01, elapsed_seconds=time.monotonic() - started), indent=2))
        report = json.loads((out / "report.json").read_text())
        report["reload_verified"] = True
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(f"PASS: saved adapter reloaded in fresh process; all {len(rows)} losses agree", flush=True)
        return

    before = evaluate("before", generate=False)
    FastVisionModel.for_training(model)
    params = [p for p in model.parameters() if p.requires_grad]
    named = [(n, p) for n, p in model.named_parameters() if p.requires_grad]
    assert all("lora_" in n for n, p in named), "Base weights must remain frozen"
    branches = {
        "vision": [p for n, p in named if ".visual." in n],
        "language": [p for n, p in named if ".visual." not in n],
    }
    assert all(branches.values()), "Both vision and language LoRA must be trainable"
    print("TRAINABLE", {k: sum(p.numel() for p in v) for k, v in branches.items()}, flush=True)
    optimizer = torch.optim.AdamW(params, lr=1e-4)
    losses = []
    best_f1, best_epoch = -1, None
    rng = random.Random(42)
    for epoch in range(args.epochs):
        FastVisionModel.for_training(model)
        order = list(range(len(rows)))
        if args.round2:
            rng.shuffle(order)
        for index in order:
            row, batch = rows[index], batches[index]
            step_started = time.monotonic()
            optimizer.zero_grad(set_to_none=True)
            loss = model_loss(model, batch)
            assert torch.isfinite(loss)
            loss.backward()
            grads = [p for p in params if p.grad is not None]
            assert grads and all(torch.isfinite(p.grad).all() for p in grads)
            changed = {k: next(p for p in values if p.grad is not None and p.grad.abs().max() > 0)
                       for k, values in branches.items()}
            old = {k: p.detach().clone() for k, p in changed.items()}
            norm = torch.nn.utils.clip_grad_norm_(params, 1.0)
            assert torch.isfinite(norm)
            optimizer.step()
            assert all(not torch.equal(old[k], p) for k, p in changed.items()), "Both LoRA branches must update"
            torch.cuda.synchronize()
            record = dict(vision_updated=True, language_updated=True, step=len(losses)+1, epoch=epoch+1, id=row["id"], loss=loss.item(),
                seconds=time.monotonic()-step_started, grad_norm=norm.item(),
                peak_GiB=torch.cuda.max_memory_allocated()/2**30,
                reserved_GiB=torch.cuda.max_memory_reserved()/2**30,
                free_GiB=torch.cuda.mem_get_info()[0]/2**30)
            losses.append(record)
            (out / "steps.json").write_text(json.dumps(losses, indent=2))
            print("TRAIN", json.dumps(record), flush=True)
        if args.round2:
            optimizer.zero_grad(set_to_none=True)
            results = evaluate(f"validation-epoch-{epoch+1}", held_out=True)
            metrics = summarize_fields(results)
            if metrics["f1"] > best_f1:
                best_f1, best_epoch = metrics["f1"], epoch + 1
                model.save_pretrained(out / "adapter")
                processor.save_pretrained(out / "adapter")
                # Loss-only reload reference; avoid another 65-image generation pass.
                evaluate("after", generate=False)
            metrics.update(epoch=epoch+1, best_epoch=best_epoch, best_f1=best_f1)
            (out / f"validation-summary-{epoch+1}.json").write_text(json.dumps(metrics, indent=2))
            print("VALIDATION", json.dumps(metrics), flush=True)
    optimizer.zero_grad(set_to_none=True)
    if args.round2:
        after = json.loads((out / "after.json").read_text())
    else:
        model.save_pretrained(out / "adapter")
        processor.save_pretrained(out / "adapter")
        after = evaluate("after")
    improved = all(b["loss"] < a["loss"] for a, b in zip(before, after))
    report = dict(scope=("validation-selected adapter; locked test pending; not strict blind-test evidence"
        if args.round2 else "draft-label training-set fit only; no held-out generalization claim"),
        round2=args.round2, best_epoch=best_epoch, best_validation_f1=best_f1 if args.round2 else None,
        finetune_vision_layers=True, finetune_language_layers=True, base_weights="frozen",
        base_model=BASE, precision="bfloat16", smoke=args.smoke, every_sample_loss_improved=improved,
        prompt=PROMPT, epochs=args.epochs, steps=len(losses), seed=42,
        max_image_edge=1024, max_sequence_length=8192, lora_rank=8, learning_rate=1e-4,
        before_loss=[r["loss"] for r in before], after_loss=[r["loss"] for r in after],
        peak_GiB=torch.cuda.max_memory_allocated()/2**30,
        elapsed_seconds=time.monotonic()-started, reload_verified=False)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    if not args.round2:
        assert improved, "Loss did not improve on every sample; report and adapter retained"
    print(f"PASS: {len(rows)}-image training and adapter save; every loss improved={improved}; reload check pending", flush=True)


if __name__ == "__main__":
    main()
