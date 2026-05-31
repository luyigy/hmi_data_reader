# 104 Agent Bidirectional Communication And Context Watermark Next Handover

## Date
2026-05-31

## Why This Handover Exists

This document is the direct continuation of:

- `docs/100_FEISHU_DIRECTED_VISIBLE_AGENT_TO_AGENT_HANDOVER.md`
- `docs/101_FEISHU_NEW_BLANK_SESSION_AND_TASK_ROOM_RECENCY_HANDOVER.md`
- `docs/103_FEISHU_RUNTIME_DB_UNTRACK_AND_AGENT_SELECTOR_HANDOVER.md`
- `docs/95_CONTEXT_WATERMARK_PLAN.md`

It captures the two most important unfinished product directions:

1. real agent-to-agent bidirectional communication inside the room
2. visible per-agent context watermark / remaining-context status

The next implementation session should treat these as connected work, not separate cleanup items.

## Current State Summary

### 1. Bidirectional communication is partially landed, but still not hard-structured

Current code already contains the right conceptual building blocks:

- `deliveryIntent`
- `primaryTargetMemberId`
- `visibilityMode`
- `expectedResponderMemberIds`
- `requiredResponseMode`
- `directed_visible`
- `handoff`
- `mention_all`

Relevant code areas:

- `src/lib/live-room.ts`
- `src/lib/live-room-delivery.ts`
- `src/lib/feishu.ts`
- `src/lib/feishu-live-room-relay.ts`
- `src/app/api/live-rooms/[id]/messages/route.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`

What is already true:

- the room can represent a visible direct message
- web-side single-target send can store `directed_visible`
- Feishu relay can render assistant directed messages as `sender -> target`
- routing can sometimes cause downstream agent B to respond after A references B

What is still not true:

- the `A -> B` hop is not yet a fully reliable, explicit, structured platform action
- too much of the trigger chain still depends on parsing free-form assistant text
- operator-visible causality is still weaker than it should be

So the system is no longer "not working", but it is still not yet trustworthy enough to be considered a complete room protocol.

### 2. Context watermark exists internally, but is still invisible to the operator

Current heuristics already exist in:

- `src/lib/acpx/runner.ts`

Current thresholds:

- room messages: warn at `40`, hard at `60`
- run events: warn at `200`, hard at `400`
- transcript characters: warn near `3800`

Current behavior:

- the runner can inject a soft warning into the agent prompt
- the runner can inject a hard "compact now / ask for new-session" warning
- Feishu can send a continuity warning for expired member sessions through:
  - `src/lib/feishu-session-continuity.ts`

What is missing:

- no room-level visible progress per member
- no member badge showing "how full" their current context is
- no operator-facing way to compare which agent is near exhaustion
- no direct coupling between watermark state and the room member list

That makes session management reactive instead of proactive.

## Product Goal For Bidirectional Communication

The intended room behavior is:

1. user asks agent A to talk to agent B
2. the room shows an explicit visible hop `A -> B`
3. only B treats that message as actionable input
4. B replies visibly into the room
5. A can continue from B's reply in a controlled next step

The operator should be able to see the chain clearly, for example:

```text
你 -> codex:
你去问一下 pi，他是不是听到了，并把名字告诉你

codex -> pi-agent:
请回复一句你是否听到了，并告诉我你的名字

pi-agent:
我听到了，我叫 xxx

codex:
pi-agent 说他听到了，他的名字是 xxx
```

This is not just display polish.
It is the core execution contract.

## Product Goal For Context Watermark

The operator should be able to answer these questions immediately from the room UI:

- which agent is closest to running out of context?
- is that pressure caused by message count, event count, or transcript growth?
- which agent should be reset first with `/ap new-session`?
- is one member safe while another is already in danger?

The display should be per member, not just per room.

The correct mental model is:

- same room
- same visible discussion
- but different members can have different usable context slices and different remaining headroom

## Recommended Design Philosophy

### A. Soft input, hard internal protocol

Users can keep speaking naturally:

- `@codex 你去问一下 pi ...`
- `$pi 看一下这个问题`
- `/ap chat --from-member=codex --to-member=pi ...`

But internally the system should not depend on text pattern matching as the source of truth.

The platform should convert user/agent intent into explicit structured records before delivery.

### B. Visibility and execution routing must stay separate

A message can be:

- visible to the whole room
- but actionable only for one target

This is the key idea behind `directed_visible`.

### C. Watermark must be actionable, not decorative

Do not show a raw percentage just because it is easy.

The display should tell the operator:

- severity
- reason
- recommended action

### D. Per-member state matters more than room aggregate

A room-level total can be a useful summary, but the important operational unit is the member.

One agent may be near exhaustion while another is still fresh.

That is the state the operator needs to manage.

## Recommended Next Build Order

## Phase 1. Harden assistant-originated directed communication

Current weakness:

- assistant-originated direction still depends too much on parsing free-form `$member ...` patterns

Recommended upgrade:

- introduce an explicit machine-readable assistant-directed action
- materialize a real intermediate room message before downstream delivery

Preferred internal shape:

```json
{
  "action": "directed_visible",
  "targetMemberId": "<member-id>",
  "content": "..."
}
```

The platform should then create a real room message with:

- `senderMemberId = A`
- `primaryTargetMemberId = B`
- `deliveryIntent = directed_visible`
- `visibility = directed_visible`

Only after that message exists should B be triggered.

This change is the single most important next step for bidirectional work.

## Phase 2. Add explicit reply-chain ownership state

The platform should track something like:

- `initiatorMemberId`
- `currentExpectedResponderMemberId`
- `chainRootMessageId`
- `chainState = open | waiting | completed`

Without this, the system will keep drifting back toward broadcast semantics.

This does not need a huge new subsystem first.
It can start as message metadata and delivery-state bookkeeping.

## Phase 3. Add per-member context watermark aggregation

Do not start from UI first.
Start from a backend function that computes watermark for one member in one room.

Suggested function:

```ts
getLiveRoomMemberContextWatermark(roomId, memberId): {
  percentage: number;
  status: 'normal' | 'warning' | 'critical';
  dominantReason: 'messages' | 'events' | 'transcript';
  messageCount: number;
  eventCount: number;
  transcriptChars: number;
  remainingMessages: number;
  remainingEvents: number;
  remainingTranscriptChars: number;
}
```

Important rule:

The counts should be based on the member's actual visible context slice after the latest applicable session reset marker, not on naive room totals.

This is where the previous session-isolation work matters.

## Phase 4. Surface watermark in room roster first

The best first UI is not a big dashboard.
It is the member list inside the room.

Recommended display per member:

- name
- presence
- permission profile
- context watermark mini-bar
- short reason label

Example:

```text
codex      online   [Full]   72%  ⚠ events
pi-agent   online   [Safe]   34%  ok
claude     busy     [Dev]    88%  ! transcript
```

Web UI recommendation:

- a thin horizontal bar below or beside the member name
- color:
  - `<60%` blue/teal
  - `60-80%` amber
  - `>80%` red
- hover tooltip:
  - `45/60 messages`
  - `180/400 events`
  - `3100/4000 transcript chars`
  - `dominant: events`

This is much better than a single opaque percentage.

## Phase 5. Add Feishu-side lightweight watermark visibility

Feishu should not try to mirror the whole bar UI.

Recommended first Feishu surfaces:

1. `/ap members`
   - append a concise watermark label
   - example:
     - `- codex [id] | platform_local | online | 水位 72% ⚠`

2. soft proactive warning
   - when a member crosses warning threshold, send a concise system note

3. hard proactive warning
   - when a member crosses hard threshold, suggest `/ap new-session`

But do not spam per-message watermark notices.
Prefer threshold-crossing events only.

## Suggested UX For Watermark

The key product question is not just "how much context is left?"
It is "what should the user do next?"

So each state should map to an action:

- `normal`
  - no action
- `warning`
  - consider `/ap new-session` soon
- `critical`
  - finish current step, then reset now

The UI should make this obvious.

The room should also support "who needs reset first?" scanning at a glance.

## Important Modeling Detail

Do not conflate:

- permission profile (`Safe`, `Dev`, `Full`)
- context watermark (`34%`, `72%`, `88%`)

Both belong in the member row, but they are different axes:

- permission profile = what the member is allowed to do
- watermark = how much usable context headroom the member still has

These should appear side by side, not merged into one badge.

## Strong Recommendation About Session Strategy

For implementation work, a fresh session is recommended before building the next phase.

Reason:

- the current design discussion already spans multiple handovers
- the next work touches routing semantics, room metadata, delivery rules, and UI payloads
- this is exactly the type of feature that benefits from a clean prompt budget and a focused execution plan

Suggested new-session bootstrap order:

1. read `docs/104_AGENT_BIDIRECTIONAL_AND_CONTEXT_WATERMARK_NEXT_HANDOVER.md`
2. read `docs/100_FEISHU_DIRECTED_VISIBLE_AGENT_TO_AGENT_HANDOVER.md`
3. read `docs/95_CONTEXT_WATERMARK_PLAN.md`
4. inspect:
   - `src/lib/live-room.ts`
   - `src/lib/live-room-delivery.ts`
   - `src/lib/acpx/runner.ts`
   - `src/components/live-room/LiveRoomWorkspace.tsx`

## Concrete First Implementation Slice

If the next session wants the smallest high-value slice, do this:

1. implement backend watermark aggregation per room member
2. extend `LiveRoomMemberPayload` with:
   - `contextWatermark`
   - `permissionProfile` if not already exposed in the same place
3. show it in the room member list in Web UI
4. add `/ap members` watermark text

Why this first:

- lower execution risk than hard-structuring bidirectional delivery immediately
- immediately useful to the operator
- creates visible room-state instrumentation
- supports future decisions about when to force `new-session`

Then do the structured assistant-directed action work next.

## Concrete Second Implementation Slice

After watermark display lands, do this:

1. define explicit assistant-directed action payload
2. convert assistant-originated downstream targeting into a real room message
3. trigger downstream member delivery only from that explicit message
4. verify a deterministic `A -> B -> A` loop in Feishu and Web UI

That is the real completion criterion for bidirectional communication.

## Final Takeaway

The next feature work should not be framed as:

- "make agent messages smarter"

It should be framed as:

- "turn room collaboration into an explicit protocol with observable execution state"

`directed_visible` solves the routing/visibility half.
Context watermark solves the state-awareness half.

Together, they make the room understandable and operable for humans.
