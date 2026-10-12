"""A controller page must not claim a different page when its anchors are absent."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from page_template_registry import load_template, resolve_page_template


def line(text):
    return {"text": text, "conf": 0.99,
            "bbox": {"x_min": 0, "y_min": 0, "x_max": 40, "y_max": 20}}


def test_nested_holding_template_requires_its_anchors(tmp_path, monkeypatch):
    templates = tmp_path / "templates"
    (templates / "controller_a").mkdir(parents=True)
    (tmp_path / "contracts").mkdir()
    (tmp_path / "contracts" / "profiles.json").write_text(json.dumps({"profiles": [{
        "profile_id": "demag.injection_metering.multi_stage_holding",
        "template": "controller_a/holding.json",
    }]}))
    (templates / "controller_a" / "holding.json").write_text(json.dumps({
        "profile_id": "demag.injection_metering.multi_stage_holding",
        "ui_family": "DEMAG",
        "page": "injection_metering",
        "layout_anchors": ["保压", "实际切换"],
        "require_anchor_match": True,
    }, ensure_ascii=False))
    (templates / "demag.injection_metering.json").write_text(json.dumps({
        "ui_family": "DEMAG", "page": "injection_metering", "version": "legacy",
    }))

    holding = [line("保压"), line("实际切换")]
    page, source, selected = resolve_page_template("photo", holding, "DEMAG", templates)
    assert (page, source, selected["profile_id"]) == (
        "injection_metering", "template_anchors", "demag.injection_metering.multi_stage_holding")

    injection = [line("多级注射")]
    selected = load_template("DEMAG", "injection_metering", templates, lines=injection)
    assert selected["version"] == "legacy"

    import page_template_registry as registry
    monkeypatch.setattr(registry, "route_page", lambda *args, **kwargs: ("monitor_curve", "find_page"))
    page, _, selected = registry.resolve_page_template("photo", injection, "DEMAG", templates)
    assert (page, selected["version"]) == ("injection_metering", "legacy")
