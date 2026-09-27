"""CPU check: /data/venvs/hmi-unsloth/bin/python -m tests.check_unsloth_service."""
import json
from types import SimpleNamespace
from fastapi import HTTPException
from scripts.serve_unsloth import parse_tool_block, validate_chat_request

name, args = parse_tool_block('''<function=read_skill>
<parameter=path>references/output-schema.md</parameter>
<parameter=options>{"limit": 2}</parameter>
</function>''')
assert name == "read_skill"
assert json.loads(args) == {"path": "references/output-schema.md", "options": {"limit": 2}}
assert parse_tool_block('{"name":"list_skills","arguments":{}}') == ("list_skills", "{}")
for invalid in ("broken", "<function=x>oops</function>",
                "<function=x><parameter=a>1</parameter><parameter=a>2</parameter></function>"):
    try:
        parse_tool_block(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError("Malformed tool call accepted")
print("PASS: Qwen XML/JSON tool blocks and malformed input")

handler = SimpleNamespace(_valid_params_class=None, _unused_fields=set())
body = {"chat_template_kwargs": {"enable_thinking": False, "preserve_thinking": True}}
validate_chat_request(handler, body)
assert body == {}
for value in (None, [], {"enable_thinking": True}, {"enable_thinking": 0}, {"unknown": True}):
    try:
        validate_chat_request(handler, {"chat_template_kwargs": value})
    except HTTPException as exc:
        assert exc.status_code == 422
    else:
        raise AssertionError("Unsupported chat template options accepted")
print("PASS: chat template request validation")
