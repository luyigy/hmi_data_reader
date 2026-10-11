"""Reader saves the only active template and keeps immutable older versions."""

import json
from copy import deepcopy
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import page_template_admin as admin


def test_admin_save_keeps_old_version_and_rejects_stale_or_unauthorized(tmp_path, monkeypatch):
    source = Path(__file__).resolve().parents[1]
    profile_id = "tact5.process_settings.injection_holding_metering"
    template_file = f"{profile_id}.json"
    (tmp_path / "templates").mkdir()
    (tmp_path / "contracts").mkdir()
    fixture = json.loads((source / "templates" / template_file).read_text())
    fixture["version"] = "0.2.1"
    (tmp_path / "templates" / template_file).write_text(json.dumps(fixture))
    (tmp_path / "contracts/profiles.json").write_text(json.dumps({
        "profiles": [{"profile_id": profile_id, "template": template_file}]}))
    sample_path = Path("templates/samples") / profile_id / "Z078_20260910_shebao.json"
    fixture_path = Path("tests/fixtures/tact5_process_ocr.json")
    for relative in (sample_path, fixture_path):
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((source / relative).read_bytes())
    monkeypatch.setattr(admin, "ROOT", tmp_path)
    monkeypatch.setenv("HMI_TEMPLATE_WRITE_KEY", "test-write-key")
    app = FastAPI()
    app.include_router(admin.router)
    client = TestClient(app)
    detail = client.get(f"/api/v1/page-templates/{profile_id}").json()
    assert detail["version"] == "0.2.1"
    current = detail["template"]
    draft = deepcopy(current)
    draft["field_labels"]["冷却"]["unit"] = "ms"
    body = {"expected_version": current["version"], "template": draft,
            "confirmation": "save_confirmed"}
    url = f"/api/v1/page-templates/{profile_id}"
    assert client.put(url, json=body).status_code == 401
    headers = {"Authorization": "Bearer test-write-key"}
    preview = client.post(url + "/preview", json=body, headers=headers)
    assert preview.status_code == 200, preview.text
    assert any(field["label"] == "冷却" for field in preview.json()["fields"])
    future = tmp_path / "templates/versions" / profile_id / "0.2.2.json"
    future.parent.mkdir(parents=True)
    future.write_text("{}")
    assert client.put(url, json=body, headers=headers).status_code == 409
    future.unlink()
    saved = client.put(url, json=body, headers=headers)
    assert saved.status_code == 200, saved.text
    assert saved.json()["version"] == "0.2.2"
    assert client.put(url, json=body, headers=headers).status_code == 409
    archived = tmp_path / "templates/versions" / profile_id / "0.2.1.json"
    assert json.loads(archived.read_text()) == current
    history = client.get(url + "/versions")
    assert history.status_code == 200, history.text
    assert [(item["version"], item["active"]) for item in history.json()] == [
        ("0.2.1", False), ("0.2.2", True)]
    assert all(item["file_time"] for item in history.json())
    assert client.get(url, params={"version": "0.2.1"}).json()["template"] == current
    assert client.get(url, params={"version": "../0.2.1"}).status_code == 404
    assert client.get(url).json()["template"]["field_labels"]["冷却"]["unit"] == "ms"
    changed_identity = deepcopy(saved.json()["template"])
    changed_identity["sample_ids"] = []
    assert client.put(url, json={"expected_version": "0.2.2", "template": changed_identity,
                                 "confirmation": "save_confirmed"}, headers=headers).status_code == 422
    rollback = client.put(url, json={"expected_version": "0.2.2", "template": saved.json()["template"],
                                     "confirmation": "rollback_confirmed"}, headers=headers)
    assert rollback.status_code == 200, rollback.text
    assert rollback.json()["version"] == "0.2.3"
    assert json.loads((archived.parent / "0.2.2.json").read_text()) == saved.json()["template"]
    archived.write_text("{}")
    assert client.get(url + "/versions").status_code == 409
    archived.unlink()
    older = archived.with_name("0.2.0.json")
    older.write_text(json.dumps({**current, "version": "0.2.0"}))
    assert client.get(url + "/versions").status_code == 409
