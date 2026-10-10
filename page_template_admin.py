"""Reader-owned page template versions used by the mold administrator UI."""

import fcntl
import hmac
import json
import os
import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from scripts.export_page_package import export_page_package
from scripts.extract_families.tact5_process import extract_tact5

ROOT = Path(__file__).resolve().parent
router = APIRouter(prefix="/api/v1/page-templates", tags=["page-templates"])
EDITABLE = {"field_labels", "enum_labels", "business_profile_candidate", "layout_anchors", "stage_limits"}
PROFILE_ID = re.compile(r"[a-z0-9_]+(?:\.[a-z0-9_]+){2}")


class TemplateSave(BaseModel):
    expected_version: str
    template: dict
    confirmation: str


def _registered_path(profile_id: str, root: Path) -> Path:
    if not PROFILE_ID.fullmatch(profile_id):
        raise HTTPException(404, "页面不存在")
    registry = json.loads((root / "contracts/profiles.json").read_text(encoding="utf-8"))
    entry = next((item for item in registry["profiles"] if item["profile_id"] == profile_id), None)
    if not entry or not entry.get("template"):
        raise HTTPException(404, "页面不存在")
    path = (root / "templates" / entry["template"]).resolve()
    if not path.is_relative_to((root / "templates").resolve()) or not path.is_file():
        raise HTTPException(404, "页面模板不存在")
    return path


def _active(profile_id: str, root: Path) -> dict:
    template = json.loads(_registered_path(profile_id, root).read_text(encoding="utf-8"))
    if template.get("profile_id") != profile_id or "business_profile_candidate" not in template:
        raise HTTPException(422, "页面模板不可编辑")
    return template


def _auth(authorization: str, key: str) -> None:
    if not key:
        raise HTTPException(503, "Reader 页面模板密钥未配置")
    if not authorization.startswith("Bearer ") or not hmac.compare_digest(authorization[7:], key):
        raise HTTPException(401, "Reader 页面模板身份无效")


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    descriptor, name = tempfile.mkstemp(prefix=".page-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def save_template(profile_id: str, draft: TemplateSave, root: Path = ROOT) -> dict:
    if draft.confirmation != "save_confirmed":
        raise HTTPException(422, "请确认保存")
    if len(json.dumps(draft.template, ensure_ascii=False)) > 256_000:
        raise HTTPException(413, "页面模板过大")
    path = _registered_path(profile_id, root)
    lock_path = root / "templates/.page-template.lock"
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = _active(profile_id, root)
        if current["version"] != draft.expected_version:
            raise HTTPException(409, "页面版本已变化，请刷新后重试")
        if set(draft.template) != set(current) or any(
            draft.template[key] != current[key] for key in current if key not in EDITABLE
        ):
            raise HTTPException(422, "页面身份、版本和样本不能在字段编辑中修改")
        if any(not isinstance(draft.template[key], type(current[key])) for key in EDITABLE):
            raise HTTPException(422, "页面字段结构无效")
        if (not isinstance(draft.template["field_labels"], dict)
                or not all(isinstance(value, dict) for value in draft.template["field_labels"].values())
                or not isinstance(draft.template["enum_labels"], dict)
                or not all(isinstance(value, dict) for value in draft.template["enum_labels"].values())
                or not isinstance(draft.template["layout_anchors"], list)
                or not all(isinstance(value, str) and len(value) <= 100 for value in draft.template["layout_anchors"])):
            raise HTTPException(422, "页面字段或定位规则无效")
        try:
            for anchor in draft.template["layout_anchors"]:
                re.compile(anchor)
        except re.error:
            raise HTTPException(422, "页面定位规则不是有效表达式") from None
        old_candidate = current["business_profile_candidate"]
        new_candidate = draft.template["business_profile_candidate"]
        if not isinstance(new_candidate, dict) or any(new_candidate.get(key) != old_candidate.get(key)
                for key in ("page_id", "algorithm", "controller", "page_version", "rule_version", "field_write_review")):
            raise HTTPException(422, "业务目标身份和写入审核不能在此修改")
        if draft.template == current:
            return {"profile_id": profile_id, "version": current["version"], "template": current}
        parts = current["version"].split(".")
        if len(parts) != 3 or not all(part.isdigit() for part in parts):
            raise HTTPException(422, "当前页面版本无效")
        version = f"{parts[0]}.{parts[1]}.{int(parts[2]) + 1}"
        archive = root / "templates/versions" / profile_id / f"{current['version']}.json"
        if (root / "templates/versions" / profile_id / f"{version}.json").exists():
            raise HTTPException(409, "下一版本已存在，不能复用版本号")
        if archive.exists():
            if json.loads(archive.read_text(encoding="utf-8")) != current:
                raise HTTPException(409, "历史版本内容冲突")
        else:
            _atomic_json(archive, current)
        updated = {**draft.template, "version": version}
        _atomic_json(path, updated)
        return {"profile_id": profile_id, "version": version, "template": updated}


@router.get("")
def list_templates():
    registry = json.loads((ROOT / "contracts/profiles.json").read_text(encoding="utf-8"))
    result = []
    for item in registry["profiles"]:
        if item.get("template"):
            try:
                template = _active(item["profile_id"], ROOT)
            except HTTPException as exc:
                if exc.status_code == 422:
                    continue
                raise
            result.append({"profile_id": item["profile_id"], "version": template["version"]})
    return result


@router.get("/{profile_id}")
def get_template(profile_id: str):
    template = _active(profile_id, ROOT)
    return {"profile_id": profile_id, "version": template["version"], "template": template}


@router.get("/{profile_id}/package")
def get_package(profile_id: str, version: str | None = None):
    current = _active(profile_id, ROOT)
    try:
        return export_page_package(profile_id, version or current["version"], ROOT)
    except (ValueError, FileNotFoundError, KeyError) as exc:
        raise HTTPException(404, f"页面版本不可用：{exc}") from None


@router.post("/{profile_id}/preview")
def preview_template(profile_id: str, draft: TemplateSave, authorization: str = Header(default="")):
    _auth(authorization, os.getenv("HMI_TEMPLATE_WRITE_KEY", ""))
    current = _active(profile_id, ROOT)
    if current["version"] != draft.expected_version:
        raise HTTPException(409, "页面版本已变化，请刷新后重试")
    if draft.template.get("profile_id") != profile_id or draft.template.get("sample_ids") != current.get("sample_ids"):
        raise HTTPException(422, "页面身份或样本不一致")
    sample_id = current.get("sample_ids", [None])[0]
    if not sample_id or profile_id != "tact5.process_settings.injection_holding_metering":
        raise HTTPException(422, "此页面还没有可预览的固定样本")
    manifest = json.loads((ROOT / "templates/samples" / profile_id / f"{sample_id}.json").read_text())
    package = export_page_package(profile_id, current["version"], ROOT)
    fixture = package["samples"][0]["ocr"]
    try:
        result = extract_tact5(fixture["lines"], draft.template,
                               {"screen_size": manifest["original_size"]})
        fields = result["detail"]["page_observations"]["fields"]
    except (KeyError, TypeError, ValueError, IndexError) as exc:
        raise HTTPException(422, f"样本预览失败：{exc}") from None
    return {"sample_id": sample_id, "fields": [
        {"label": field["label"], "value": field["value"], "unit": field["unit"],
         "state": field["state"]} for field in fields]}


@router.put("/{profile_id}")
def put_template(profile_id: str, draft: TemplateSave, authorization: str = Header(default="")):
    _auth(authorization, os.getenv("HMI_TEMPLATE_WRITE_KEY", ""))
    return save_template(profile_id, draft, ROOT)
