# 100 Feishu Directed Visible Agent To Agent Handover

## Date

2026-05-25

## Purpose

This handover captures the current state of the Feishu-first `directed_visible` work, the code that has already landed, the real test results observed in the live room, and the recommended next implementation plan for the next session.

The next session should use this file as the primary starting point.

## Scope Completed In This Session

The following foundation is now in code:

1. a first-class `directed_visible` room message intent exists
2. web composer single-target send can explicitly create `directed_visible`
3. assistant-originated single-target replies can be stored as `directed_visible`
4. Feishu relay can render directed-visible assistant messages as `sender -> target`
5. Feishu has a manual directed test command for debugging
6. live-room agent prompting was updated to prefer `$member ...` instead of `@member ...` for room-internal directed communication

## Files Changed

- `src/lib/live-room.ts`
- `src/lib/live-room-delivery.ts`
- `src/lib/feishu.ts`
- `src/lib/feishu-live-room-relay.ts`
- `src/app/api/live-rooms/[id]/messages/route.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`
- `scripts/list-available-agents.ts`

## What Landed

### 1. `directed_visible` became a first-class room intent

`src/lib/live-room.ts` now includes:

- `LiveRoomDeliveryIntent = 'directed_visible'`
- `LiveRoomMessageMetadata.visibilityMode`
- `resolveLiveRoomMessageMetadata(...)` support for `visibilityMode: 'directed_visible'`

This means room messages no longer have to fake this behavior through plain mention metadata alone.

### 2. Web single-target composer can now emit visible direct messages

`src/app/api/live-rooms/[id]/messages/route.ts` and `src/components/live-room/LiveRoomWorkspace.tsx` now support:

- `visibilityMode` on send
- storing the message itself with `visibility: 'directed_visible'`
- timeline rendering of `sender -> target`
- a `room-visible direct` badge

This is useful groundwork, but it is not the main user-facing success criterion because the operator currently needs Feishu, not the web UI.

### 3. Feishu relay can display directed-visible messages

`src/lib/feishu-live-room-relay.ts` now formats assistant directed messages as:

```text
sender -> target:
message body
```

This is required for the meeting-style operator experience.

### 4. Feishu manual directed test entry exists

`src/lib/feishu.ts` now supports:

```text
/ap chat --from-member=codex --to-member=pi ...
```

This is only a debugging/test backdoor. It is not the desired end-state UX.

### 5. Live-room agent prompting now prefers `$member`

`src/lib/live-room-delivery.ts` was updated so that when an agent needs to contact another room member, the intended protocol is:

```text
$pi ...
```

not:

```text
@pi ...
```

This aligns with the room’s existing internal syntax and avoids conflicts with Feishu native `@mention`.

### 6. Target inference from the user’s natural-language request was added

When a user says something like:

```text
@codex 你去问一下 pi ...
```

the current target member (`codex`) is stripped from the front of the user message and the remaining content is scanned to infer the intended downstream member (`pi`).

That inferred downstream target is then injected into the live-room prompt so the current agent is told which member it should contact.

## Real Test Results

### Runtime restart state

The user manually restarted the active user-level services after code changes:

- `agent-platform-dev.service`
  - `ActiveEnterTimestamp=Mon 2026-05-25 19:54:12 CST`
- `agent-platform-feishu.service`
  - `ActiveEnterTimestamp=Mon 2026-05-25 19:54:18 CST`

So subsequent Feishu tests were running against the updated code, not stale processes.

### Live-room / Feishu test room used

- room title: `Local Room Test`
- room id: `cmnd3r8r900003cvx88079wd9`
- Feishu chat id: `oc_b634823504e29e6220de0cfb5108a216`

Relevant members observed during testing:

- `codex`
- `pi-agent`

### What actually happened in real tests

The user repeatedly tested the natural-language path:

```text
@codex 你去问一下 pi，跟他打个招呼，让他回一句是不是听到了，然后告诉你他的名字
```

Observed results:

1. the user message successfully entered the live room
2. it was successfully delivered to `codex`
3. `codex` sometimes stayed `running` for a while
4. in at least one real run, `pi-agent` started processing and the user saw:
   - `系统提示：pi-agent 已开始处理这条消息`
5. however, the user did **not** see an explicit visible intermediate message like:

```text
codex -> pi-agent:
...
```

This is the most important current finding.

## Current Diagnosis

The system is no longer fully broken, but it is still not robust enough.

What appears to be true now:

1. the routing chain can sometimes cause `pi-agent` to respond
2. but the operator-visible `codex -> pi-agent` step is not yet reliably materialized as a true explicit room message
3. therefore the current behavior still looks too close to weak-structure text triggering

In other words:

- the chain can fire
- but it is still too easy for the trigger to come from text pattern matching instead of a clearly structured assistant-originated directed action

This is why the operator observed behavior that felt like:

- weak structure
- possible false positive
- no clear visible directed hop

That diagnosis is correct.

## Why The Current Approach Is Still Too Weak

The current implementation still relies too much on parsing free-form assistant text for a leading `$member` / mention-like pattern.

That is acceptable as a short bridge, but it has these problems:

1. accidental mention-like text can trigger routing
2. explanation text can be confused with a real directed action
3. the room transcript may not clearly show the true intended hop
4. the operator cannot always distinguish:
   - explanation
   - mention
   - actual directed-visible instruction

So even though the routing sometimes works, it is not yet trustworthy enough for a meeting-style multi-agent workflow.

## Recommended Next Plan

The next session should stop treating free-form `$member ...` parsing as the final protocol and upgrade assistant-originated directed communication to a harder structure.

### Phase 1. Introduce a hard-structured assistant directed action

Recommended direction:

Use one of these patterns for assistant-originated room-internal direction:

Option A:

```text
[[directed_visible:pi]]
请回复一句是不是听到了，并告诉我你的名字
```

Option B:

```json
{"action":"directed_visible","target":"pi","content":"请回复一句是不是听到了，并告诉我你的名字"}
```

Preferred direction: Option B or another equivalently explicit machine-readable structure.

Why:

- it avoids accidental regex hits
- it distinguishes explanation from actual routing intent
- it gives the platform one exact place to create a true room message
- it makes auditing and UI rendering straightforward

### Phase 2. Materialize an explicit intermediate room message

When `codex` decides to contact `pi-agent`, the platform should create a real message record with:

- `senderMemberId = codex`
- `primaryTargetMemberId = pi-agent`
- `deliveryIntent = directed_visible`
- `visibility = directed_visible`

Then Feishu relay and room timeline should render the actual visible hop:

```text
codex -> pi-agent:
请回复一句是不是听到了，并告诉我你的名字
```

Only after that message exists should the platform trigger `pi-agent` delivery.

### Phase 3. Keep `$member` for user ergonomics, but not as the source of truth

User-facing input can still allow:

- Feishu `@codex`
- `$pi`
- natural language like `你去问一下 pi ...`

But internal assistant-to-assistant routing truth should not depend on plain regex alone.

The right engineering split is:

1. user input can stay soft
2. internal routing state must become hard
3. room/Feishu display can stay human-readable

## Suggested Next Implementation Order

1. add a hard-structured assistant directed-action parse path in `src/lib/live-room-delivery.ts`
2. create a real intermediate room message from that structured action before downstream delivery
3. relay that intermediate message to Feishu as `sender -> target`
4. only then trigger the downstream target member
5. keep the current `$member` parsing only as fallback, or remove it once the structured action path is stable

## Verification Status

Verified in this session:

- `npx eslint src/lib/live-room.ts src/lib/live-room-delivery.ts src/lib/feishu.ts src/lib/feishu-live-room-relay.ts src/app/api/live-rooms/[id]/messages/route.ts src/components/live-room/LiveRoomWorkspace.tsx scripts/list-available-agents.ts`
- `npx tsc --noEmit`

Both passed on 2026-05-25 before handover.

Not yet fully verified:

- a clean end-to-end Feishu run where the operator explicitly sees:
  - the original user request
  - `codex -> pi-agent`
  - `pi-agent` reply
  - no unrelated agent cross-talk

That should be the first acceptance test in the next session after the structured-action path is implemented.

## Remote `pi-agent` Status

The user provided updated remote TX-server information:

- executable path: `/home/ww/.local/node/bin/pi`
- version: `0.75.5`
- `pi -p "Hello, what model are you?"` returns a normal text answer

This is materially better than the earlier remote `0.73.x` behavior.

However, remote `pi-agent` integration was not the primary blocker in this session. The main unresolved issue is still the same-room visible directed hop semantics in Feishu.

So the next session should finish the hard-structured directed-visible protocol first, then re-check remote `pi-agent` under the same routing model.

## Handover Summary

This session successfully landed the first-class `directed_visible` foundations, Feishu relay formatting, a `$member`-oriented prompt protocol, and natural-language target inference.

The core unresolved issue is that the operator did not yet reliably see a true explicit `codex -> pi-agent` intermediate message. Routing can fire, but it still appears too dependent on weak-structure text matching.

The next session should convert assistant-originated agent-to-agent communication from weak text parsing into a hard structured action and make the intermediate directed-visible room message explicit and visible in Feishu.
