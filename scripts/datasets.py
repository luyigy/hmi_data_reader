"""双层真值数据集（031 PLAN S01）：calibration/holdout/regression 三分区治理。

目录结构：
    datasets/<partition>/<profile_id>/<case_id>.truth.yml   人维护（领域核对后的真值）
    datasets/<partition>/<profile_id>/<case_id>.meta.json   机器生成（本脚本 build）
    datasets/<partition>/<profile_id>/<image>               真值对应图片（随 case 归档）
    datasets/release_manifest.json                          机器生成的发布清单

truth.yml 最小 schema（缺任一键硬失败）：
    schema_version / case_id / profile_id / controller_family / page_type /
    hmi_variant / allow_auto_import / image.file / fields / provenance
    可选 references: [case_id, ...]（练习册不得引用 holdout case，见校验 7）

meta.json（机器生成，禁止手改；内容确定性、无时间戳，可整体重算比对）：
    case_id / truth_hash（truth 规范化 JSON 的 sha256）/ image_sha256 /
    schema_version / contract_version / profile_id / profile_layout_version /
    structure / field_meta（字段目录子集）/ provenance

硬失败校验（031 PLAN §4.2/§4.4）：
1. truth.yml 缺必需键；
2. truth/meta 不成对（孤儿 meta 或缺失 meta）；
3. meta 内容与 truth/图片/目录重算结果不一致（篡改任一 hash 即在此被抓）；
4. 同一分区内 case_id 重复；
5. 跨分区 case_id 或 image_sha256 重复（分区污染）；
6. truth 字段未在字段目录登记（不给未接入字段编造语义）；
7. calibration/regression 的 references 引用 holdout case；
8. profile_id 未在注册表登记或目录名与 truth profile_id 不符。

用法：
    .venv/bin/python scripts/datasets.py build    # 生成 meta + 校验 + 发布清单
    .venv/bin/python scripts/datasets.py check    # 只校验（CI/篡改复现，不写文件）
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from hashlib import sha256
from pathlib import Path

import yaml

from contract import _build_field_meta

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASETS = REPO_ROOT / "datasets"
DEFAULT_CATALOG = REPO_ROOT / "contracts" / "field_catalog.json"
DEFAULT_REGISTRY = REPO_ROOT / "contracts" / "profiles.json"
DEFAULT_MANIFEST = DEFAULT_DATASETS / "release_manifest.json"

SCHEMA_VERSION = "1.0.0"
PARTITIONS = ("calibration", "holdout", "regression")
# profile_layout_version 仅 reader 内部持久化（021 §5.2），首版布局统一为 1
DEFAULT_LAYOUT_VERSION = 1

TRUTH_REQUIRED_KEYS = (
    "schema_version", "case_id", "profile_id", "controller_family",
    "page_type", "hmi_variant", "allow_auto_import", "image", "fields",
    "provenance",
)


class DatasetError(Exception):
    """数据集治理硬失败。"""


def _canonical_hash(payload: dict) -> str:
    """dict -> 规范化 JSON 的 sha256（与 yml 排版无关，绑定内容）。"""
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False,
                     separators=(",", ":"))
    return f"sha256:{sha256(blob.encode('utf-8')).hexdigest()}"


def _file_sha256(path: Path) -> str:
    return f"sha256:{sha256(path.read_bytes()).hexdigest()}"


def _reader_commit() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT,
            capture_output=True, check=True, text=True,
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def load_catalog(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_registry_ids(path: Path) -> set[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {p.get("profile_id") for p in data.get("profiles", [])} - {None}


def scan_cases(datasets_dir: Path) -> list[dict]:
    """扫描全部 truth.yml，返回 case 记录（含 partition/dir/path/truth）。"""
    cases = []
    for partition in PARTITIONS:
        part_dir = datasets_dir / partition
        if not part_dir.is_dir():
            continue
        for truth_path in sorted(part_dir.glob("*/*.truth.yml")):
            truth = yaml.safe_load(truth_path.read_text(encoding="utf-8"))
            cases.append({
                "partition": partition,
                "dir": truth_path.parent.name,
                "path": truth_path,
                "truth": truth if isinstance(truth, dict) else None,
            })
    return cases


def _validate_truth_schema(case: dict, errors: list[str]) -> None:
    truth = case["truth"]
    label = f"{case['partition']}/{case['dir']}/{case['path'].name}"
    if truth is None:
        errors.append(f"{label}: truth.yml 不是合法 YAML mapping")
        return
    missing = [k for k in TRUTH_REQUIRED_KEYS if k not in truth]
    if missing:
        errors.append(f"{label}: truth.yml 缺必需键 {missing}")
        return
    image = truth.get("image")
    if not isinstance(image, dict) or not image.get("file"):
        errors.append(f"{label}: truth.yml image.file 缺失")
    if not isinstance(truth.get("fields"), dict) or not truth["fields"]:
        errors.append(f"{label}: truth.yml fields 缺失或为空")
    if not isinstance(truth.get("provenance"), dict):
        errors.append(f"{label}: truth.yml provenance 必须是 mapping")
    if truth.get("schema_version") != SCHEMA_VERSION:
        errors.append(
            f"{label}: schema_version={truth.get('schema_version')!r} "
            f"不在支持范围（当前 {SCHEMA_VERSION}）")
    if case["dir"] != truth.get("profile_id"):
        errors.append(
            f"{label}: 目录名 {case['dir']!r} 与 truth profile_id "
            f"{truth.get('profile_id')!r} 不符")
    references = truth.get("references")
    if references is not None and not (
            isinstance(references, list)
            and all(isinstance(r, str) for r in references)):
        errors.append(f"{label}: references 必须是 case_id 字符串列表")


def build_meta(case: dict, catalog: dict) -> dict:
    """由 truth + 图片 + 字段目录重算 meta（确定性，无时间戳）。"""
    truth = case["truth"]
    image_path = case["path"].parent / truth["image"]["file"]
    return {
        "schema_version": SCHEMA_VERSION,
        "case_id": truth["case_id"],
        "profile_id": truth["profile_id"],
        "profile_layout_version": DEFAULT_LAYOUT_VERSION,
        "contract_version": catalog.get("contract_version"),
        "truth_hash": _canonical_hash(truth),
        "image_sha256": _file_sha256(image_path),
        "structure": {
            "controller_family": truth["controller_family"],
            "page_type": truth["page_type"],
            "hmi_variant": truth["hmi_variant"],
            "allow_auto_import": truth["allow_auto_import"],
            "image": truth["image"]["file"],
            "n_fields": len(truth["fields"]),
        },
        "field_meta": _build_field_meta(
            truth["fields"], catalog.get("fields", {}), truth["profile_id"]),
        "provenance": truth["provenance"],
    }


def _meta_path(case: dict) -> Path:
    return case["path"].with_suffix("").with_suffix(".meta.json")


def validate(datasets_dir: Path, catalog: dict, registry_ids: set[str],
             *, write: bool) -> tuple[list[dict], list[str]]:
    """校验整个数据集；write=True 时先重写全部 meta。返回 (cases, errors)。"""
    errors: list[str] = []
    cases = scan_cases(datasets_dir)

    for case in cases:
        _validate_truth_schema(case, errors)
    valid = [c for c in cases if c["truth"] is not None
             and not any(k not in c["truth"] for k in TRUTH_REQUIRED_KEYS)]

    catalog_fields = catalog.get("fields", {})
    for case in valid:
        truth = case["truth"]
        label = f"{case['partition']}/{case['dir']}/{case['path'].name}"
        unregistered = sorted(k for k in truth["fields"] if k not in catalog_fields)
        if unregistered:
            errors.append(f"{label}: truth 字段未在字段目录登记 {unregistered}")
        if truth["profile_id"] not in registry_ids:
            errors.append(f"{label}: profile_id {truth['profile_id']!r} 未在注册表登记")
        image_path = case["path"].parent / (truth.get("image") or {}).get("file", "")
        if not image_path.is_file():
            errors.append(f"{label}: 图片缺失 {image_path.name}")
            continue
        meta_path = _meta_path(case)
        expected = build_meta(case, catalog)
        if write:
            meta_path.write_text(
                json.dumps(expected, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8")
        elif not meta_path.is_file():
            errors.append(f"{label}: 缺机器生成 meta（先跑 datasets.py build）")
        else:
            try:
                actual = json.loads(meta_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                errors.append(f"{label}: meta.json 不是合法 JSON")
                continue
            if actual != expected:
                drift = sorted(k for k in set(actual) | set(expected)
                               if actual.get(k) != expected.get(k))
                errors.append(
                    f"{label}: meta 与 truth/图片/目录不一致（疑似篡改或未重新生成），"
                    f"漂移键 {drift}")

    # truth/meta 成对：孤儿 meta（无对应 truth）硬失败
    for partition in PARTITIONS:
        part_dir = datasets_dir / partition
        if not part_dir.is_dir():
            continue
        for meta_path in sorted(part_dir.glob("*/*.meta.json")):
            truth_path = meta_path.with_suffix("").with_suffix(".truth.yml")
            if not truth_path.is_file():
                errors.append(f"{meta_path.relative_to(datasets_dir)}: 孤儿 meta，"
                              f"缺对应 truth.yml")

    # 分区内 case 重复
    seen: dict[tuple[str, str], str] = {}
    for case in valid:
        key = (case["partition"], case["truth"]["case_id"])
        if key in seen:
            errors.append(f"case_id {key[1]!r} 在分区 {key[0]} 内重复"
                          f"（{seen[key]} 与 {case['path'].name}）")
        seen[key] = case["path"].name

    # 跨分区重复（case_id 或 image_sha256）：分区污染硬失败
    owner: dict[str, str] = {}
    image_owner: dict[str, str] = {}
    for case in valid:
        truth = case["truth"]
        where = f"{case['partition']}:{truth['case_id']}"
        prev = owner.setdefault(truth["case_id"], where)
        if prev.split(":", 1)[0] != case["partition"]:
            errors.append(f"case_id {truth['case_id']!r} 跨分区重复（{prev} 与 {where}）")
        image_path = case["path"].parent / (truth.get("image") or {}).get("file", "")
        if image_path.is_file():
            digest = _file_sha256(image_path)
            prev_img = image_owner.setdefault(digest, where)
            if prev_img.split(":", 1)[0] != case["partition"]:
                errors.append(f"图片 {truth['image']['file']!r} 跨分区重复"
                              f"（{prev_img} 与 {where}，同图不得进两个分区）")

    # 练习册不得引用 holdout case
    holdout_ids = {c["truth"]["case_id"] for c in valid if c["partition"] == "holdout"}
    for case in valid:
        if case["partition"] == "holdout":
            continue
        for ref in case["truth"].get("references") or []:
            if ref in holdout_ids:
                errors.append(f"{case['partition']} case "
                              f"{case['truth']['case_id']!r} 引用 holdout case "
                              f"{ref!r}（考卷不得被练习册引用）")

    return cases, errors


def build_manifest(cases: list[dict], catalog: dict) -> dict:
    partitions: dict[str, list[dict]] = {p: [] for p in PARTITIONS}
    for case in sorted(cases, key=lambda c: (c["partition"], c["truth"]["case_id"])):
        if case["truth"] is None:
            continue
        meta = json.loads(_meta_path(case).read_text(encoding="utf-8"))
        partitions[case["partition"]].append({
            "case_id": meta["case_id"],
            "profile_id": meta["profile_id"],
            "truth_hash": meta["truth_hash"],
            "image_sha256": meta["image_sha256"],
            "path": f"{case['partition']}/{case['dir']}/{case['path'].name}",
        })
    return {
        "schema_version": SCHEMA_VERSION,
        "generator": "scripts/datasets.py",
        "contract_version": catalog.get("contract_version"),
        "reader_commit": _reader_commit(),
        "partitions": partitions,
        "totals": {p: len(partitions[p]) for p in PARTITIONS},
    }


def check_manifest(manifest_path: Path, expected: dict) -> list[str]:
    """比对已发布清单（reader_commit 为信息性字段，不参与比对）。"""
    if not manifest_path.is_file():
        return ["release_manifest.json 缺失（先跑 datasets.py build）"]
    try:
        actual = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return ["release_manifest.json 不是合法 JSON"]
    errors = []
    for key in ("schema_version", "contract_version", "partitions", "totals"):
        if actual.get(key) != expected.get(key):
            errors.append(f"release_manifest.json 的 {key} 与数据集现状不一致"
                          f"（疑似篡改或未重新生成）")
    return errors


def main() -> None:
    ap = argparse.ArgumentParser(description="双层真值数据集：生成 meta、校验、发布清单")
    ap.add_argument("command", choices=("build", "check"))
    ap.add_argument("--datasets", type=Path, default=DEFAULT_DATASETS)
    ap.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    ap.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    ap.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    args = ap.parse_args()

    catalog = load_catalog(args.catalog)
    registry_ids = load_registry_ids(args.registry)
    write = args.command == "build"

    cases, errors = validate(args.datasets, catalog, registry_ids, write=write)
    valid = [c for c in cases if c["truth"] is not None]
    if not errors:
        manifest = build_manifest(valid, catalog)
        if write:
            args.manifest.parent.mkdir(parents=True, exist_ok=True)
            args.manifest.write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8")
        else:
            errors.extend(check_manifest(args.manifest, manifest))

    if errors:
        for err in errors:
            print(f"[datasets] ERROR: {err}")
        sys.exit(1)
    n_meta = len(valid)
    print(f"[datasets] {args.command} OK：{n_meta} 个 case"
          f"（calibration/holdout/regression = "
          f"{sum(1 for c in valid if c['partition'] == 'calibration')}/"
          f"{sum(1 for c in valid if c['partition'] == 'holdout')}/"
          f"{sum(1 for c in valid if c['partition'] == 'regression')}）")
    if write:
        print(f"[datasets] manifest -> {args.manifest}")


if __name__ == "__main__":
    main()
