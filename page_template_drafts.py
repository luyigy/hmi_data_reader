"""Authenticated HTTP contracts for the Reader template lifecycle."""
import os

from fastapi import APIRouter, Header
from pydantic import BaseModel, ConfigDict, Field

from page_template_lifecycle import publish_draft, read_draft, save_draft, trial_draft

router = APIRouter(prefix="/drafts")


class DraftSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: str | None
    expected_revision: int | None = Field(default=None, ge=1)
    template: dict
    samples: list[dict]


class DraftTrial(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)


class DraftPublish(DraftTrial):
    expected_version: str | None
    confirmation: str


def _authorize(authorization):
    from page_template_admin import ROOT, _auth
    _auth(authorization, os.getenv("HMI_TEMPLATE_WRITE_KEY", ""))
    return ROOT


@router.put("/{profile_id}")
def put_draft(profile_id: str, body: DraftSave, authorization: str = Header(default="")):
    root = _authorize(authorization)
    return save_draft(root, profile_id, **body.model_dump())


@router.get("/{profile_id}")
def get_draft(profile_id: str, authorization: str = Header(default="")):
    return read_draft(_authorize(authorization), profile_id)


@router.post("/{profile_id}/trial")
def post_trial(profile_id: str, body: DraftTrial, authorization: str = Header(default="")):
    return trial_draft(_authorize(authorization), profile_id, body.expected_revision)


@router.post("/{profile_id}/publish")
def post_publish(profile_id: str, body: DraftPublish, authorization: str = Header(default="")):
    return publish_draft(_authorize(authorization), profile_id, **body.model_dump())
