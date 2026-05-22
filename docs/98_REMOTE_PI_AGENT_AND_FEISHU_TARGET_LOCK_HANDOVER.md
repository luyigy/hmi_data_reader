# 98 Remote Pi Agent And Feishu Target Lock Handover

## Date

2026-05-22

## Status

Implementation done in code, but service restart / live verification should be finished via `systemd --user`.

Current state:

- `remote_ssh + pi-agent` execution branch has been added
- Remote SSH host UI now exposes `pi-agent`
- Feishu structured single-member mention now locks reply routing to the intended target
- A remote `pi-agent` session-dir bug was found and fixed in code

## Files Changed

- `src/app/remote-ssh-tools/page.tsx`
- `src/lib/remote-harness/ssh-executor.ts`
- `src/lib/feishu-api.ts`
- `src/lib/feishu-live-room.ts`
- `src/lib/live-room-delivery.ts`

## What Was Changed

### 1. Remote SSH host UI now supports `pi-agent`

In:

- `src/app/remote-ssh-tools/page.tsx`

The supported harness checklist now includes:

- `codex`
- `claude`
- `pi-agent`

This only affects host declaration / editing in the web UI.

### 2. Remote SSH executor now supports `pi-agent`

In:

- `src/lib/remote-harness/ssh-executor.ts`

Added:

- remote harness command mapping for `pi-agent`
- remote probe command mapping for `pi-agent`
- remote continuation session identity as `pi_session_dir`

Important implementation details:

- remote executable defaults to `pi`
- PATH is prefixed with `"$HOME/.local/node/bin"`
- first run uses `-p`
- continuation uses `--continue`
- session identity is stored as a stable remote session dir

Expected remote command shape is now effectively:

```bash
export PATH="$HOME/.local/node/bin:$PATH"
pi --session-dir "$HOME/.pi/agent/sessions/acpx-<task>" -p "<prompt>"
```

Continuation:

```bash
export PATH="$HOME/.local/node/bin:$PATH"
pi --session-dir "$HOME/.pi/agent/sessions/acpx-<task>" --continue "<message>"
```

### 3. Feishu group title resolution was added

In:

- `src/lib/feishu-api.ts`
- `src/lib/feishu-live-room.ts`

Added:

- `getFeishuChatInfo(chatId)`

This lets a bound Feishu group room use the real Feishu chat name as default room title instead of a generic fallback.

### 4. Structured Feishu mention now locks target routing

In:

- `src/lib/feishu-live-room.ts`
- `src/lib/live-room-delivery.ts`

When a Feishu message contains exactly one structured mention target:

- metadata now records `targetLocked: true`
- delivery resolution only allows that intended target member to reply
- fallback to other candidates is suppressed for that message

This was added to reduce "串台 / 抢话", especially cases where another Claude-like member replied after the user clearly mentioned a different target.

## Important Bug Found During Validation

### Remote Pi session dir bug

Observed failure:

```text
EACCES: permission denied, mkdir '~/.pi/agent/sessions/...'
```

Cause:

- remote session dir was originally passed as literal `~/.pi/...`
- remote Node / Pi did not expand `~`
- Pi then tried to create a path literally under a `~` directory relative to current cwd

Fix:

- default remote pi session root changed from `~/.pi/agent/sessions` to `$HOME/.pi/agent/sessions`
- remote unix / powershell command builders now preserve `$HOME` semantics correctly
- continuation also respects `$HOME` / `~/...` forms

## Verification Performed

### Type check

Ran:

```bash
npx tsc --noEmit
```

Result:

- no new type errors from this change set after the routing fix
- repository still has pre-existing unrelated errors in:
  - `scripts/list-available-agents.ts`

Observed errors:

```text
Cannot find module './src/lib/live-room'
Parameter 'a' implicitly has an 'any' type
```

These were not introduced by this task.

## Operational Notes

This environment is managed by `systemd --user`, not `nohup`.

Relevant services:

- `agent-platform-dev.service`
- `agent-platform-feishu.service`

Useful commands:

```bash
systemctl --user restart agent-platform-dev.service
systemctl --user restart agent-platform-feishu.service
systemctl --user status agent-platform-dev.service --no-pager
systemctl --user status agent-platform-feishu.service --no-pager
journalctl --user -u agent-platform-dev.service -n 200 --no-pager
journalctl --user -u agent-platform-feishu.service -n 200 --no-pager
```

At inspection time, both user services existed and were enabled:

- `agent-platform-dev.service`
- `agent-platform-feishu.service`

## Recommended Next Steps

1. Restart both user services via `systemd --user`
2. Re-test remote `pi-agent` in the live room
3. Confirm the previous `EACCES mkdir '~/.pi/...'` failure no longer appears
4. Re-test the Feishu single-mention case that previously caused Claude抢话
5. If needed, extend `/ap register` examples/help text to mention `pi-agent`

## Summary

This handover includes two functional changes and one bug fix:

- `remote_ssh + pi-agent` is wired into the platform
- Feishu structured single-target routing is now locked to the intended member
- remote Pi session dir expansion bug is fixed in code

The remaining work is primarily operational verification after restarting the user-managed services.
