"""Local operator CLI for the same draft/trial/publication contract as HTTP.

python3 scripts/manage_page_templates.py --root /reader save controller.page.layout --body draft.json
python3 scripts/manage_page_templates.py --root /reader trial controller.page.layout --body trial.json
python3 scripts/manage_page_templates.py --root /reader publish controller.page.layout --body publish.json
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from page_template_drafts import DraftPublish, DraftSave, DraftTrial
from page_template_lifecycle import publish_draft, read_draft, save_draft, trial_draft
from pydantic import ValidationError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("command", choices=("save", "get", "trial", "publish"))
    parser.add_argument("profile_id")
    parser.add_argument("--body", type=Path, help="JSON body, identical to the HTTP request")
    args = parser.parse_args()
    try:
        if args.command == "get":
            result = read_draft(args.root, args.profile_id)
        else:
            if args.body is None:
                parser.error("--body is required for save, trial and publish")
            model, action = {"save": (DraftSave, save_draft), "trial": (DraftTrial, trial_draft),
                             "publish": (DraftPublish, publish_draft)}[args.command]
            body = model.model_validate_json(args.body.read_text())
            result = action(args.root, args.profile_id, **body.model_dump())
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (HTTPException, ValidationError, OSError, ValueError) as exc:
        print(json.dumps({"status": getattr(exc, "status_code", 422),
                          "detail": str(getattr(exc, "detail", exc))}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
