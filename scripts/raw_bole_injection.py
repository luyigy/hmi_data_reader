"""Versioned B&R injection/holding observations from physical OCR cells."""

import copy
import hashlib
import json
import re
from pathlib import Path

from raw_contract import canonical_hash, import_raw_package
from raw_page import _line_box
from extract_families.coordinates import project_boxes

ROOT = Path(__file__).resolve().parents[1]
PROFILE = "b_and_r.injection_holding.multi_stage_position_time"
VERSION = "0.6.0"
DEFINITION = "contracts/raw-pages/b-and-r-injection-0.6.0.json"
FILES = ("scripts/raw_bole_injection.py", "scripts/raw_contract.py", "scripts/raw_page.py",
         "scripts/extract_families/coordinates.py", DEFINITION)
NUMBER = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*(mm/s|mm|bar|%|sec|s)?\s*$", re.I)


def build_bole_injection_package(samples):
    definition = json.loads((ROOT / DEFINITION).read_text())
    expected = {sample["sample_id"]: sample["image_sha256"] for sample in definition["samples"]}
    provided = {sample["manifest"]["sample_id"]: sample["manifest"]["original_sha256"] for sample in samples}
    if provided != expected or len(samples) != len(expected) or len(set(provided.values())) != len(expected):
        raise ValueError("BOLE_INJECTION_FROZEN_SAMPLES_REQUIRED")
    template = json.loads((ROOT / "templates/b_and_r/injection_holding.json").read_text())
    template.update(version=VERSION, extractor="registered_extractor",
                    extractor_id="b_and_r.injection_metering", extractor_version="1",
                    layout_variant=definition["page_identity"]["layout_variant"],
                    page_identity={**definition["page_identity"],
                                   "evidence_sample_ids": [s["sample_id"] for s in definition["samples"]]},
                    sample_ids=[s["sample_id"] for s in definition["samples"]])
    contract = json.loads((ROOT / "contracts/page_observations.v2.schema.json").read_text())
    sources = {path: (ROOT / path).read_text() for path in FILES}
    files = {path: hashlib.sha256(source.encode()).hexdigest() for path, source in sources.items()}
    return dict(package_schema="hmi_raw_page_package.v2", profile_id=PROFILE, version=VERSION,
                template=template, raw_contract=contract, raw_contract_sha256=canonical_hash(contract),
                raw_field_definition=definition, raw_field_definition_sha256=canonical_hash(definition),
                recognizer=dict(id="b_and_r.injection_ocr.v2", version=VERSION, files=files,
                                sources=sources, sha256=canonical_hash(files)), samples=samples)


def bole_injection_package(root=ROOT):
    package = import_raw_package(json.loads((Path(root) / "templates/raw-packages" / PROFILE / f"{VERSION}.json").read_text()))
    if package["profile_id"] != PROFILE or package["version"] != VERSION:
        raise ValueError("RAW_PACKAGE_IDENTITY_MISMATCH")
    if package["raw_field_definition"] != json.loads((ROOT / DEFINITION).read_text()):
        raise ValueError("RAW_DEFINITION_MISMATCH")
    recognizer = package["recognizer"]
    files = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in FILES}
    if (recognizer.get("id") != "b_and_r.injection_ocr.v2" or recognizer["files"] != files
            or recognizer["sha256"] != canonical_hash(files)
            or {path: hashlib.sha256(source.encode()).hexdigest()
                for path, source in recognizer["sources"].items()} != files):
        raise ValueError("RAW_RECOGNIZER_HASH_MISMATCH")
    return package


def observe_bole_injection(lines, meta, image_sha256, root=ROOT):
    if image_sha256 is not None and not re.fullmatch(r"[a-f0-9]{64}", image_sha256):
        raise ValueError("IMAGE_HASH_INVALID")
    package = bole_injection_package(root)
    definition = package["raw_field_definition"]
    width, height = meta["screen_size"]
    cells = []
    for line in lines:
        box = _line_box(line)
        cells.append(dict(line=line, text=re.sub(r"\s+", "", line["text"]),
                          x=(box[0] + box[2]) / (2 * width),
                          y=(box[1] + box[3]) / (2 * height), match=NUMBER.fullmatch(line["text"])))

    sections, issues = {}, list(definition["issues"])
    for section, label in (("injection", "射胶"), ("holding", "保压")):
        titles = [c for c in cells if c["text"] == label and .3 < c["x"] < .8 and .3 < c["y"] < .68]
        if len(titles) != 1:
            raise ValueError("BOLE_INJECTION_LAYOUT_UNVERIFIED")
        title = titles[0]
        heads = sorted([c for c in cells if c["text"] in {"1", "2", "3", "4", "5"}
                        and .2 < c["x"] < .95 and 0 < c["y"] - title["y"] < .04], key=lambda c: c["x"])
        ids = [int(c["text"]) for c in heads]
        conflict = len(ids) != len(set(ids))
        if conflict:
            issues.append(dict(code="STAGE_IDENTITY_CONFLICT", section=section))
        if set(ids) != {1, 2, 3, 4, 5}:
            issues.append(dict(code="STAGE_HEADERS_PARTIAL", section=section))
        sections[section] = dict(title=title, heads=heads, conflict=conflict)
    if not sections["injection"]["title"]["y"] < sections["holding"]["title"]["y"]:
        raise ValueError("BOLE_INJECTION_LAYOUT_CONFLICT")

    fields = []
    for spec in definition["fields"]:
        section = spec["section"]
        source_label, header, options, order = None, None, [], spec.get("order")
        conflict = False
        if spec.get("stage"):
            table = sections[section]
            y0 = table["title"]["y"]
            y1 = sections["holding"]["title"]["y"] if section == "injection" else .7
            labels = [c for c in cells if c["text"] in spec["labels"] and c["x"] < .2 and y0 < c["y"] < y1]
            source_label = labels[0] if len(labels) == 1 else None
            matching = [c for c in table["heads"] if int(c["text"]) == spec["stage"]]
            header = matching[0] if len(matching) == 1 else None
            conflict = table["conflict"] or len(labels) > 1
            if source_label and not conflict:
                physical_slot = (min(range(1, 6), key=lambda stage: abs(
                    definition["stage_column_centers"][str(stage)] - header["x"])) if header else spec["stage"])
                order = (table["heads"].index(header) + 1 if header and len(table["heads"]) == 5 else 6 - physical_slot)
                hx = header["x"] if header else definition["stage_column_centers"][str(spec["stage"])]
                options = [c for c in cells if c["match"] and abs(c["y"] - source_label["y"]) < .013
                           and abs(c["x"] - hx) < .075]
        elif spec.get("value_type") != "boolean":
            labels = [c for c in cells if c["text"] in spec["labels"]
                      and spec["label_region"][0] < c["x"] < spec["label_region"][2]
                      and spec["label_region"][1] < c["y"] < spec["label_region"][3]]
            source_label = labels[0] if len(labels) == 1 else None
            conflict = len(labels) > 1
            if source_label:
                if spec.get("direction") == "right":
                    options = [c for c in cells if c["match"] and .04 < c["x"] - source_label["x"] < .25
                               and abs(c["y"] - source_label["y"]) < .018]
                else:
                    options = [c for c in cells if c["match"] and 0 < c["y"] - source_label["y"] < .05
                               and abs(c["x"] - source_label["x"]) < .065]
        source = options[0] if len(options) == 1 and not conflict else None
        unit = source["match"][2] if source else None
        if source and unit is None:
            unit_cells = [c for c in cells if c["text"].lower() in {"%", "bar", "mm", "mm/s", "sec", "s"}
                          and abs(c["y"] - source["y"]) < .015 and c["x"] > source["x"]
                          and (c["x"] - source["x"] < .16 or spec.get("stage"))]
            units = {c["line"]["text"] for c in unit_cells}
            unit = next(iter(units)) if len(units) == 1 else None
        confidence = source["line"].get("conf", source["line"].get("confidence", 0)) if source else None
        reading = ("unsupported" if spec.get("value_type") == "boolean" else
                   "conflict" if conflict or len(options) > 1 else "missing" if source is None else
                   "uncertain" if confidence < .9 or source_label["text"] != spec["label"]
                   or spec.get("stage") and (header is None or header["line"].get("conf", 0) < .9) else "known")
        if unit and ("s" if unit.lower() == "sec" else unit.lower()) != spec["unit"]:
            reading = "conflict"
        field = {key: spec[key] for key in ("screen_field_key", "section", "role", "stage", "segment_id", "time_kind") if key in spec}
        field.update(source="image_recognition", original_label=source_label["line"]["text"] if source_label else None,
                     original_value=float(source["match"][1]) if source else None,
                     original_unit=unit, effective_unit=unit or spec["unit"], state="unknown", reading=reading,
                     order=order, identity_basis="ocr_header" if header else "frozen_field_definition",
                     bbox=_line_box(source["line"]) if source else None, original_bbox=None,
                     text=source["line"]["text"] if source else None, confidence=confidence,
                     reasons=["enable_state_unverified"],
                     template_ref=dict(profile_id=PROFILE, version=VERSION,
                                       sha256=package["raw_field_definition_sha256"],
                                       unit=spec["unit"] if unit is None else None))
        if reading != "known":
            issues.append(dict(code="READING_" + reading.upper(), screen_field_key=spec["screen_field_key"]))
        fields.append(field)
    project_boxes(fields, meta)
    for field in fields:
        if field["original_bbox"] is None:
            field["reasons"].append("source_box_unavailable")
    transform = copy.deepcopy(meta)
    transform.update(rectifier_input_sha256=meta.get("original_sha256"), original_sha256=image_sha256)
    return dict(schema_version="page_observations.v2", source="image_recognition", profile_id=PROFILE,
                page_identity=definition["page_identity"], image_sha256=image_sha256,
                original_size=meta.get("original_size"), coordinate_space="original_percent", transform=transform,
                raw_field_definition_sha256=package["raw_field_definition_sha256"],
                raw_field_definition_version=VERSION, raw_contract_sha256=package["raw_contract_sha256"],
                recognizer=package["recognizer"], package_sha256=canonical_hash(package), fields=fields, issues=issues,
                ocr_evidence=dict(coordinate_space="rectified_pixels", screen_size=meta["screen_size"], lines=lines),
                coverage=dict(status="partial", declared=len(fields), known=sum(f["reading"] == "known" for f in fields)))
