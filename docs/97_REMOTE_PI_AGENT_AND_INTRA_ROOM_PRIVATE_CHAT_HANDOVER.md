# 97 Remote Pi Agent And Intra-Room Private Chat Handover

## Date

2026-05-19

## Status

Analysis complete.

Current state:

- `platform_local + pi-agent` is implemented and validated
- `remote_ssh + pi-agent` is not yet fully implemented
- user also wants future support for agent-to-agent private chat inside the same room, while keeping those private messages visible to the human user

## What Was Completed Before This Handover

### 1. Local Pi Agent integration is done

`pi-agent` has already been integrated as a first-class `platform_local` harness through:

- `src/lib/real-agents/pi-agent.ts`
- `src/lib/harness/adapters/pi-agent.ts`
- `src/lib/harness/registry.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/catalog.ts`
- `src/lib/platform-local-init.ts`

Validated outcome:

- `pi-agent` appears in `/ap agents` after service restart
- it can be added into the current room
- room conversation with `pi-agent` executes successfully

### 2. Pi executable facts were confirmed

Confirmed local launch entry:

```bash
/data1/code/pi-mono/pi-test.sh --version
```

Observed version:

```text
0.74.0
```

Confirmed useful CLI capabilities:

- `--print`
- `--mode json`
- `--continue`
- `--session-dir`
- `--no-session`
- `--extension`
- `--provider`
- `--model`

This is why Pi was integrated as a proper local CLI harness instead of a TUI-scraping hack.

## Current Analysis: Why Remote Pi Agent Is Not Yet Supported

The user already has a remote SSH host at `10.0.8.10`.
That host already exposes a remote Claude agent into the platform.
The user also wants a remote Pi agent from that same machine.

Current code does not fully support that path yet.

### 1. Remote SSH host UI only exposes Claude and Codex

In:

- `src/app/remote-ssh-tools/page.tsx`

the supported harness checklist is still hard-coded to:

- `codex`
- `claude`

So the UI cannot currently declare `pi-agent` for a remote host.

### 2. Remote host storage/API is flexible enough

In:

- `src/app/api/remote-harness-hosts/route.ts`
- `src/app/api/remote-harness-hosts/[id]/route.ts`

the backend normalizes `supportedHarnesses`, but does not strongly restrict values to only Claude/Codex.

That means `pi-agent` can likely be stored as host metadata.

### 3. The real blocker is the remote SSH executor

In:

- `src/lib/remote-harness/ssh-executor.ts`

the actual remote command builder only supports:

- `codex`
- `claude`

Anything else currently throws:

```ts
Unsupported remote harness: ${harnessType}
```

So even if `pi-agent` were forced into the host metadata, actual execution would still fail.

### 4. Remote probe logic also assumes harness name == command name

The remote probe path does checks like:

```bash
<harness> --version
```

But Pi may not be exposed remotely as a globally discoverable `pi-agent` command.
The known local working entry is repo-relative:

```bash
cd /data1/code/pi-mono && ./pi-test.sh --version
```

So remote Pi support needs a harness-specific command template, not just a harness string.

## Information Still Missing From TX-server Claude / TCC

The user intended to ask the remote Claude agent on `10.0.8.10` for the real Pi runtime details, but that reply had not arrived at the time of this handover.

Still needed from the remote machine:

1. actual Pi launch command on `10.0.8.10`
2. actual version command
3. a known-good non-interactive command
4. whether `--continue` works as expected there
5. whether custom provider / extension flags are required on that machine
6. actual working directory for the Pi repo on that server

Recommended exact questions:

```text
1. which pi-agent / which pi / exact executable path
2. version command
3. non-interactive print command
4. continuation command using session-dir + --continue
5. required provider/model/extension/env configuration
6. repo path for pi-mono
```

## Recommended Plan: Remote Pi Agent

### Phase 1. Enable remote host declaration

Update:

- `src/app/remote-ssh-tools/page.tsx`

Add `pi-agent` to the supported harness UI.

This only exposes the option. It does not make execution work by itself.

### Phase 2. Add remote Pi execution branch

Update:

- `src/lib/remote-harness/ssh-executor.ts`

Needed changes:

1. add `pi-agent` branch in remote command builder
2. define real remote command shape
3. define remote continuation shape
4. define remote probe logic

Expected command style will likely be something close to:

```bash
cd /data1/code/pi-mono && ./pi-test.sh --print ...
```

For continuation, likely:

```bash
cd /data1/code/pi-mono && ./pi-test.sh --session-dir <dir> --continue ...
```

### Phase 3. Define remote continuation identity

For remote Pi, the current best direction is the same principle used for local Pi:

- stable dedicated `session-dir`
- store that directory as continuation identity
- resume by `--continue`

This is preferable to trying to persist one concrete session file path.

### Phase 4. Add provider / extension passthrough

Because Pi supports:

- `--provider`
- `--model`
- `--extension`

and custom providers via extension registration,
remote Pi support should leave room for host-level or harness-level runtime configuration.

This can be staged:

1. first hard-code the known-good remote launch command
2. then add configurable remote command/profile support later

## Recommended Plan: Same-Room Agent Private Chat With Human Visibility

The user also wants a future capability:

- agents inside the same room can privately message each other
- but the human user must still be able to see that private conversation

This should not be implemented as literally hidden traffic.

### Product interpretation

The most consistent interpretation is:

- message is targeted from one agent to another agent
- normal room participants do not automatically treat it as a broadcast task
- but the human user still sees the private exchange in the room timeline
- the UI clearly marks it as directed / private / agent-to-agent

So "private" here should mean:

- scoped delivery
- not hidden from the human operator

### Recommended delivery model

Add a new message visibility / routing model in room messages:

1. `broadcast`
2. `directed_visible`
3. later if ever needed: `system_internal`

For the requested feature, use `directed_visible`.

Behavior:

- sender agent chooses a specific target agent
- only the target agent treats it as actionable direct input
- message still renders in timeline for the user
- timeline UI shows something like:
  - `A -> B`
  - `private`
  - `directed`

### Why this is better than true hidden private chat

Because the platform is user-supervised orchestration.
If agents truly exchange hidden messages, the operator loses debuggability and trust.

The user explicitly asked that the content still be visible.
That means the correct model is "directed but visible", not "secret".

### Likely implementation areas

Future work will probably touch:

- room message schema / metadata
- message routing logic
- live-room delivery target selection
- UI rendering for directed agent-to-agent messages
- mention / targeting grammar

Likely files:

- `src/lib/live-room.ts`
- `src/lib/live-room-delivery.ts`
- `src/lib/feishu-live-room.ts`
- relevant live-room UI components

### Suggested command / syntax direction

Possible future syntax:

```text
$tcc -> $pi 请确认远端 pi-test.sh 的启动参数
```

or

```text
/ap dm --from=tcc --to=pi "请确认远端 pi-test.sh 的启动参数"
```

But the routing semantics matter more than the exact command syntax in the first design pass.

### Recommended UX requirements

1. user can always see the content
2. timeline clearly shows sender and intended recipient
3. only the addressed agent should execute/respond by default
4. room summary / replay should preserve directed-message markers
5. later moderation/audit should be possible

## Immediate Next Steps For The Next Session

1. Get the reply from TX-server Claude / TCC with the actual remote Pi runtime details
2. Add `pi-agent` to remote SSH host supported harness UI
3. Implement `remote_ssh + pi-agent` branch in `ssh-executor.ts`
4. Validate remote probe
5. Validate `/ap add --agents=remote_ssh:<hostId>:pi-agent`
6. Validate actual room execution
7. After that, start design work for directed-visible intra-room private chat

## Final Conclusion

At handover time:

- local Pi support is done
- remote Pi support is not done yet, but the missing work is now clearly scoped
- same-room agent private chat should be designed as directed-visible messaging, not hidden messaging

This document is intended to let the next session continue immediately without re-deriving the architecture constraints.
