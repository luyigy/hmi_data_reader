# 106 Feishu Auto-Bind, Default Agent Fallback, And Remote Workdir Next Handover

## Date
2026-06-02

## Scope Of This Session

This session followed the watermark presentation cleanup and then handled a smaller but high-value Feishu usability slice:

1. separate watermark usage vs policy semantics
2. improve Feishu `/ap members` and web member UI wording/colors
3. auto-bind a brand-new Feishu group to a live room on first normal message
4. provide a default agent fallback for that auto-bound room
5. document the correct runtime restart method for this repo

This session did **not** implement agent-executable room-control actions such as "invite these members into the room" or member-level remote working directories.

## Files Changed

- `src/lib/live-room.ts`
- `src/types/index.ts`
- `src/lib/feishu.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`
- `src/lib/feishu-live-room.ts`
- `src/lib/feishu-long-connection.ts`
- `src/app/api/feishu/webhook/route.ts`
- `CLAUDE.md`
- `docs/SYSTEMD_USER_COMMANDS.md`

## What Landed

### 1. Watermark semantics are now explicit

The live-room member watermark payload is no longer overloaded.

`contextWatermark` now separates:

- `usagePercentage`
- `usageStatus`
- `policyStatus`
- `policyLabel`

The important behavior change is:

- `84%` now means estimated context usage
- `within policy` / `warning` / `reset now` now means threshold state

So confusing output like:

- `84% ok transcript`

was replaced with explicit wording such as:

- `用量 84% (transcript) | 策略 within policy`

### 2. Feishu `/ap members` and web roster now match the new semantics

Updated:

- `src/lib/feishu.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`

Current behavior:

- Feishu shows usage and policy separately
- web roster shows a usage badge plus a separate policy badge
- progress bar color is tied to usage band, not policy state

This keeps the existing per-member watermark aggregation but fixes the presentation mismatch.

### 3. New Feishu groups can now auto-bind on first normal message

This was the main product usability change from the second half of the session.

Behavior:

- if a Feishu **group** is not yet bound to a live room
- and a normal non-command message arrives
- the platform now auto-creates/binds a live room
- then relays that same first message into the room

Important implementation note:

The first version only updated the webhook path, which was insufficient because this environment actually runs through:

- `agent-platform-feishu.service`
- long-connection mode

That bug was then fixed by also patching:

- `src/lib/feishu-long-connection.ts`

After that fix, auto-bind no longer depends on webhook-only flow.

### 4. Default agent fallback now prefers local pi-agent, with codex as fallback

Updated in:

- `src/lib/feishu-live-room.ts`

Current selection order:

1. local `pi-agent`
2. local `codex`
3. another local platform agent
4. first available catalog agent

This was chosen because local pi-agent is cheaper for generic first-contact room usage, while codex remains the reliable fallback.

### 5. `/ap room` without `--agents` now also uses the default fallback

Updated in:

- `src/lib/feishu.ts`

This means operators no longer need to specify a full agent id just to create the first room binding in a new Feishu chat.

### 6. Restart guidance is now documented explicitly

Updated:

- `CLAUDE.md`
- `docs/SYSTEMD_USER_COMMANDS.md`

Current operational rule:

- this repo is managed by user-level `systemd`
- do **not** treat `nohup` or manual background `npm run ...` as the canonical runtime path

Correct restart command:

```bash
systemctl --user restart agent-platform-dev.service agent-platform-feishu.service
```

If service files changed:

```bash
systemctl --user daemon-reload
systemctl --user restart agent-platform-dev.service agent-platform-feishu.service
```

## What Was Verified

### Verified

- watermark wording change is visible in Feishu `/ap members`
- long-connection runtime logs were inspected directly
- new Feishu-group message flow reached the runtime
- service management is confirmed to be user-level `systemd`

### Important bug found and fixed in-session

The first auto-bind implementation did **not** work in practice because:

- the running environment used long-connection mode
- long-connection still ignored unbound non-command group messages

This was corrected by applying the same auto-bind flow in:

- `src/lib/feishu-long-connection.ts`

### Not yet re-verified end-to-end after the final long-connection patch

The last patch widened auto-bind further:

- auto-bind no longer depends on Feishu mention recognition
- any first normal message in an unbound group should now create the room

This final version should be tested in a fresh Feishu group after restart.

## Key Product Findings

### A. Auto-bind should not depend on mention structure

The test group `sci-mold` showed that plain text containing `@_user_1` did not reliably satisfy the earlier "bot was mentioned" condition.

So the trigger was widened from:

- unbound group + bot structured mention

to:

- unbound group + first normal message

This better matches the user’s actual expectation for "bring bot into a new group and start talking".

### B. Agent invitation is not a prompt problem; it is a structured action problem

The user asked the default agent to invite other agents into the room.

Observed issue:

- default agent can understand the request
- but does not have a reliable execution path for room-control operations

Examples of missing structured control actions:

- add members to current live room
- bind/update current room metadata
- set remote host working directory for this room/member

This is not solved by "better natural language instructions" alone.

The real missing piece is a hard execution contract for assistant-originated room-control actions.

### C. Remote workdir semantics are currently host-level, not member-level

Current model:

- room/source task can have one room-level `workingDirectory`
- each `RemoteHarnessHost` can also have its own `workingDirectory`

This means:

- different remote servers can already use different directories via host config
- but multiple members on the **same** remote host cannot yet cleanly use different directories

For the user’s `sci-mold` scenario:

- `/data/deploy/mold-data-webpage-tool` is a remote TX-server path
- that path should not be treated as a platform-local room workspace
- the better current fit is the `RemoteHarnessHost.workingDirectory` for the relevant SSH host

## What Is Still Not Finished

### 1. Agent-executable room control is still missing

Highest-value missing capability:

- let an agent in the room explicitly request "add these members to the room"
- have the platform actually perform that mutation

Recommended minimal first slice:

- one structured action for `add_members_to_current_room`

### 2. Member-level remote workdir is still missing

Current limitation:

- remote cwd is effectively host-level
- not room-member-level

Recommended future shape:

- per-room-member optional `workingDirectoryOverride`
- fallback order:
  1. member override
  2. remote host default workingDirectory
  3. room/source-task workingDirectory
  4. process cwd / shell default

### 3. Hard-structured assistant-originated directed_visible is still unfinished

This remains the larger protocol task from `104` and `105`.

Do not lose sight of it just because the Feishu auto-bind slice landed.

## Recommended Next Session

Read in this order:

1. `docs/106_FEISHU_AUTO_BIND_DEFAULT_AGENT_AND_REMOTE_WORKDIR_NEXT_HANDOVER.md`
2. `docs/105_LIVE_ROOM_MEMBER_WATERMARK_SLICE_HANDOVER.md`
3. `docs/104_AGENT_BIDIRECTIONAL_AND_CONTEXT_WATERMARK_NEXT_HANDOVER.md`

Then inspect:

- `src/lib/feishu-long-connection.ts`
- `src/lib/feishu-live-room.ts`
- `src/lib/feishu.ts`
- `src/lib/live-room.ts`
- `src/lib/live-room-delivery.ts`

Suggested implementation order:

1. validate fresh-group auto-bind end-to-end in Feishu
2. add a minimal assistant room-control action for "add members"
3. then design member-level remote working directory override
4. only after that resume the broader hard-structured directed-visible protocol work

## Suggested Commit Theme

- split watermark usage vs policy semantics
- auto-bind new Feishu groups to default local agent
- prefer local pi-agent with codex fallback
- document user-level systemd runtime management

## Short Takeaway

This session successfully improved watermark semantics and significantly reduced Feishu room bootstrap friction.

A brand-new Feishu group should now auto-bind on first normal message, with local `pi-agent` preferred and local `codex` as fallback.

The next real product gap is no longer room bootstrap.
It is agent-executable room control, especially "invite/add these members into the current room", plus the related remote working-directory model.
