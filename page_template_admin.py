"""Reader-owned page template versions used by the mold administrator UI."""

import fcntl
import hmac
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from page_template_store import atomic_json as _atomic_json
from scripts.export_page_package import export_page_package
from scripts.extract_fields import extract_page_fields, norm_tokens

ROOT = Path(__file__).resolve().parent
router = APIRouter(prefix="/api/v1/page-templates", tags=["page-templates"])
EDITABLE = {"field_labels", "enum_labels", "business_profile_candidate", "layout_anchors", "stage_limits", "enabled"}
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


def save_template(profile_id: str, draft: TemplateSave, root: Path = ROOT) -> dict:
    if draft.confirmation not in ("save_confirmed", "rollback_confirmed"):
        raise HTTPException(422, "请确认保存")
    if len(json.dumps(draft.template, ensure_ascii=False)) > 256_000:
        raise HTTPException(413, "页面模板过大")
    path = _registered_path(profile_id, root)
    if any(path.is_relative_to((root / "templates" / directory).resolve())
           for directory in ("versions", "published")):
        raise HTTPException(409, "已发布版本不可修改，请创建草稿后发布新版本")
    lock_path = root / "templates/.page-template.lock"
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = _active(profile_id, root)
        if current["version"] != draft.expected_version:
            raise HTTPException(409, "页面版本已变化，请刷新后重试")
        added = set(draft.template) - set(current)
        if added not in (set(), {"enabled"}) or set(current) - set(draft.template) or any(
            draft.template[key] != current[key] for key in current if key not in EDITABLE
        ):
            raise HTTPException(422, "页面身份、版本和样本不能在字段编辑中修改")
        if "enabled" in draft.template and type(draft.template["enabled"]) is not bool:
            raise HTTPException(422, "页面启停状态无效")
        if any(not isinstance(draft.template[key], type(current[key])) for key in EDITABLE & current.keys()):
            raise HTTPException(422, "页面字段结构无效")
        field_labels = draft.template.get("field_labels", {})
        enum_labels = draft.template.get("enum_labels", {})
        if (not isinstance(field_labels, dict)
                or not all(isinstance(value, dict) for value in field_labels.values())
                or not isinstance(enum_labels, dict)
                or not all(isinstance(value, dict) for value in enum_labels.values())
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
        if draft.template == current and draft.confirmation == "save_confirmed":
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
            result.append({"profile_id": item["profile_id"], "version": template["version"],
                           "enabled": template.get("enabled", True)})
    return result


@router.get("/{profile_id}")
def get_template(profile_id: str, version: str | None = None):
    current = _active(profile_id, ROOT)
    if version is None or version == current["version"]:
        template = current
    else:
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
            raise HTTPException(404, "页面版本不存在")
        path = ROOT / "templates/versions" / profile_id / f"{version}.json"
        if not path.resolve().is_relative_to((ROOT / "templates/versions" / profile_id).resolve()) or not path.is_file():
            raise HTTPException(404, "页面版本不存在")
        try:
            template = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise HTTPException(409, "历史版本文件无效") from None
        if template.get("profile_id") != profile_id or template.get("version") != version:
            raise HTTPException(409, "历史版本身份不一致")
    return {"profile_id": profile_id, "version": template["version"], "template": template}


@router.get("/{profile_id}/versions")
def get_template_versions(profile_id: str):
    current = _active(profile_id, ROOT)
    active = _registered_path(profile_id, ROOT)
    archive_dir = ROOT / "templates/versions" / profile_id
    versions = []
    for path in archive_dir.glob("*.json"):
        version = path.stem
        if version == current["version"] and json.loads(path.read_text()) == current:
            continue
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
            raise HTTPException(409, "历史版本文件名无效")
        if tuple(map(int, version.split("."))) >= tuple(map(int, current["version"].split("."))):
            raise HTTPException(409, "历史版本不能晚于或等于生效版本")
        get_template(profile_id, version)
        versions.append({"version": version, "file_time": datetime.fromtimestamp(
            path.stat().st_mtime, timezone.utc).isoformat(), "active": False})
    versions.append({"version": current["version"], "file_time": datetime.fromtimestamp(
        active.stat().st_mtime, timezone.utc).isoformat(), "active": True})
    versions.sort(key=lambda item: tuple(map(int, item["version"].split("."))))
    for before, after in zip(versions, versions[1:]):
        old_parts = tuple(map(int, before["version"].split(".")))
        new_parts = tuple(map(int, after["version"].split(".")))
        if old_parts[:2] == new_parts[:2] and new_parts[2] != old_parts[2] + 1:
            raise HTTPException(409, "历史版本归档有缺口")
    return versions


@router.get("/{profile_id}/package")
def get_package(profile_id: str, version: str | None = None):
    if version == "0.4.0":
        try:
            return export_page_package(profile_id, version, ROOT)
        except (ValueError, FileNotFoundError, KeyError) as exc:
            raise HTTPException(404, f"页面版本不可用：{exc}") from None
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
    if not sample_id:
        raise HTTPException(422, "此页面还没有可预览的固定样本")
    manifest = json.loads((ROOT / "templates/samples" / profile_id / f"{sample_id}.json").read_text())
    package = export_page_package(profile_id, current["version"], ROOT)
    fixture = package["samples"][0]["ocr"]
    try:
        screen_size = manifest.get("screen_size", manifest["original_size"])
        lines = []
        for line in fixture["lines"]:
            box = line["bbox"]
            lines.append({"text": line["text"], "conf": line.get("conf", line.get("confidence")),
                          "bbox": dict(zip(("x_min", "y_min", "x_max", "y_max"), box))
                          if isinstance(box, list) else box})
        # Preview computes fixed-sample observations without activating the draft.
        result = extract_page_fields(norm_tokens({"lines": lines}, screen_size), {**draft.template, "enabled": True},
                                     ocr_lines=lines, meta={"screen_size": screen_size})
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


from page_template_drafts import router as drafts_router  # noqa: E402

router.include_router(drafts_router)
