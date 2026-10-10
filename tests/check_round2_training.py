"""CPU-only regression: python3 -m tests.check_round2_training."""
import json
from scripts.train_small_sample import ROOT, field_metrics, read_evaluation, read_samples, summarize_fields

truth = {"速度": {"value": 0, "unit": "mm/s"}, "时间": {"value": 2, "unit": "s"}}
perfect = field_metrics(json.dumps({"fields": truth}), truth)
assert perfect["exact_page"] and summarize_fields([perfect])["f1"] == 1
extra = field_metrics(json.dumps({"fields": dict(truth, 多报={"value": 1, "unit": "s"})}), truth)
assert not extra["exact_page"] and summarize_fields([extra])["f1"] == 0.8
wrong = field_metrics('{"fields":{"速度":{"value":1,"unit":"mm/s"}}}', truth)
assert wrong["wrong_value_unit"] == 1 and wrong["missing_fields"] == ["时间"]
for response in ('broken', '[]', '{"fields":[]}', '{}'):
    result = field_metrics(response, truth)
    assert not result["json_valid"] and summarize_fields([result])["f1"] == 0
assert field_metrics('{"fields":{"速度":null}}', truth)["wrong_value_unit"] == 1
assert field_metrics('{"fields":{"速度":{"value":"0","unit":"mm/s"}}}', truth)["value_unit_correct"] == 0
assert field_metrics('{"fields":{"速度":{"value":0,"unit":"s"}}}', truth)["value_unit_correct"] == 0

train = read_samples(ROOT / "datasets/hmi/catalog/training-manifest-20260927-tact5.json")
validation = read_evaluation("validation", train)
test = read_evaluation("test", train + validation)
assert (len(train), len(validation), len(test)) == (65, 6, 9)
try:
    read_evaluation("validation", train + validation)
except AssertionError:
    pass
else:
    raise AssertionError("Overlapping images must be rejected")
print("PASS: strict field scores, extra/missing/wrong fields, invalid JSON, frozen 65/6/9 splits, leakage rejection")
