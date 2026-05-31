# 101 Feishu New Blank Session And Task Room Recency Handover

## Date

2026-05-31

## Summary

This batch fixes three linked Feishu/live-room session issues:

1. `/ap new-session` was too verbose and had no short alias.
2. There was no true "blank fresh session" mode; the first run still inherited room/task bootstrap context by default.
3. Task-room prompt building fetched the oldest `N` messages instead of the newest `N`, so agents could keep acting on stale instructions even after the user asked a new question.

The resulting user-visible symptom was:

- `/ap new --blank` appeared to succeed
- but the remote agent still continued investigating an older issue

The final root cause was not only old live-room progress still streaming, but also a prompt-context recency bug in task-room message loading.

## Changes

### 1. Add `/ap new` alias

Updated:

- `src/lib/feishu.ts`

Effect:

- `/ap new ...` now maps to `/ap new-session ...`
- existing `/ap new-session ...` remains supported
- handover helper text now recommends the short form

### 2. Add true blank bootstrap mode

Updated:

- `src/lib/feishu.ts`

Effect:

- `/ap new --blank ...` skips task-room bootstrap injection
- if no handover file is provided, the initial prompt becomes:
  - fresh blank session
  - do not assume prior transcript
  - wait for the next user instruction

This changes the bootstrap behavior only for the new-session startup path.

### 3. Interrupt previous remote live-room replies before new session

Updated:

- `src/lib/feishu.ts`

Effect:

- for `remote_ssh` members, `/ap new` attempts to interrupt the member's current live-room reply and queued deliveries before launching the fresh session
- this reduces visible leakage from older in-flight replies during a manual session reset

### 4. Fix task-room context recency bug

Updated:

- `src/lib/task-room.ts`

Root cause:

- `getTaskRoomMessages()` queried `createdAt asc` with `take limit`
- that returns the oldest `limit` rows, not the newest ones
- downstream prompt building then derived `latestUserMessage` from an already stale slice

Fix:

- fetch newest messages via `createdAt desc`
- then reverse in memory to preserve chronological order for transcript formatting

Effect:

- `buildTaskRoomPromptContext()` now sees the actual latest user message
- `buildHarnessPrompt()` now injects the newest task-room instruction instead of a stale older one

## Validation

Local verification completed:

- `npx tsc --noEmit --pretty false`

Manual Feishu validation outcome after restart:

- `/ap new --blank --profile=full tcc` now behaves correctly
- the reported issue "agent still investigates the previous problem" is resolved

## User-Facing Semantics After This Batch

### `/ap new`

Behavior:

- starts a fresh session
- still uses current room/task state unless `--blank` or `--handover` is provided

### `/ap new --blank`

Behavior:

- starts a fresh blank session
- does not inject old room/task transcript into the bootstrap prompt
- for remote SSH members, attempts to interrupt previous reply work first

### `/ap new --handover="docs/xxx.md"`

Behavior:

- starts a fresh session
- reads the provided handover first

## Important Operational Note

These changes live in the Feishu runtime path, so they require restarting:

```bash
systemctl --user restart agent-platform-feishu.service
```

The Next.js dev service (`agent-platform-dev.service`) is not the primary restart requirement for this batch.

## Next Topic: Agent-Agent Bidirectional Communication

The next area to push is not more session-reset polish. It is real bidirectional agent-to-agent communication.

Current assessment:

- we already have partial directed-visible relay / handoff behavior
- but it is still asymmetric and prompt-driven
- the system does not yet provide a robust "agent A asks agent B, B replies back, A continues" loop with clear ownership, visibility, and continuation guarantees

### Recommended next milestones

1. Define the exact protocol surface.

Decide whether the canonical primitive is:

- visible directed message (`$member ...`)
- explicit handoff event
- private agent-to-agent message
- or a combination

Do not keep this fuzzy at the prompt level.

2. Separate visibility from execution routing.

Current logic mixes:

- what humans can see
- who is allowed to act
- who should continue next

These need explicit metadata fields and deterministic transition rules.

3. Add reply-chain ownership state.

For real bidirectional exchange, the platform should track:

- initiating member
- responding member
- expected next responder
- whether the chain is "request/response complete" or still open

Without this, agent conversations drift into broadcast semantics.

4. Prevent transcript pollution across agent loops.

The current task-room model is still optimized for user-agent turns.
Bidirectional agent messaging needs a tighter notion of:

- current active branch
- which messages should become next-run instructions
- which messages are just visible transcript

5. Add explicit tests for A->B->A.

Minimum acceptance test:

- user asks agent A to contact B
- A emits one directed message to B
- only B executes
- B replies visibly
- A can then continue from B's reply in a controlled next step

That loop should be deterministic before expanding to multi-agent mesh behavior.

## Files Changed In This Batch

- `src/lib/feishu.ts`
- `src/lib/task-room.ts`
