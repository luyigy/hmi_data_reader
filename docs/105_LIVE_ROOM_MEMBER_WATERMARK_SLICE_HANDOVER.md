# 105 Live Room Member Watermark Slice Handover

## Date
2026-06-02

## Scope Of This Session

This session implemented the first recommended slice from:

- `docs/104_AGENT_BIDIRECTIONAL_AND_CONTEXT_WATERMARK_NEXT_HANDOVER.md`

Specifically:

1. per-member context watermark for live rooms
2. expose watermark in member payloads
3. show watermark in web room UI
4. show watermark in Feishu `/ap members`

This session did **not** implement threshold-crossing proactive warnings or the next hard-structured assistant-originated `directed_visible` protocol upgrade.

## Files Changed

- `src/lib/task-room.ts`
- `src/lib/live-room.ts`
- `src/lib/workspace.ts`
- `src/lib/feishu.ts`
- `src/app/api/live-rooms/[id]/route.ts`
- `src/app/api/live-rooms/[id]/members/route.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`
- `src/types/index.ts`

## What Landed

### 1. Per-member visible-slice watermark aggregation

New task-room helpers were added in `src/lib/task-room.ts`:

- `parseTaskRoomSessionResetMarker(...)`
- `isTaskRoomMessageVisibleToParticipant(...)`
- `sliceTaskRoomMessagesForParticipant(...)`
- `buildTaskRoomTranscriptFromMessages(...)`

Key behavior:

- the member context slice is **not** naive room total
- messages are cut after the latest applicable reset marker
- visibility is filtered per member:
  - room/task/global messages count
  - messages targeted to that member count
  - that member's own outbound participant-targeted messages count
  - participant-targeted messages to other members do not count

This is intentionally compatible with future hard-structured `directed_visible` routing because the visibility/actionability split is preserved.

### 2. Live room member payload now includes watermark + permission info

`src/lib/live-room.ts` now exposes:

- `permissionProfile`
- `permissionLabel`
- `contextWatermark`

Current `contextWatermark` shape:

```ts
{
  percentage: number;
  status: 'normal' | 'warning' | 'critical';
  dominantReason: 'messages' | 'events' | 'transcript';
  dominantLabel: string;
  recommendedAction: string;
  messageCount: number;
  eventCount: number;
  transcriptChars: number;
  remainingMessages: number;
  remainingEvents: number;
  remainingTranscriptChars: number;
}
```

### 3. Watermark computation model

Current computation in `src/lib/live-room.ts` uses the max of:

- `messageCount / 60`
- `eventCount / 400`
- `transcriptChars / 4000`

Current status thresholds are inherited from existing runner heuristics:

- messages: warning `40`, critical `60`
- events: warning `200`, critical `400`
- transcript: warning `3800`, critical `4000`

Important consequence:

- a member can show `84% ok transcript`
- because `84%` is based on `3360 / 4000`
- while transcript warning does not start until `3800`

This is mathematically consistent with the current backend rules, but it is not ideal product semantics.

### 4. API surfaces updated

These now use the enriched serializer:

- `src/app/api/live-rooms/[id]/route.ts`
- `src/app/api/live-rooms/[id]/members/route.ts`
- `src/lib/workspace.ts`

### 5. Feishu `/ap members` updated

`src/lib/feishu.ts` now appends:

- permission label
- context watermark percentage
- status marker
- dominant reason

Observed after restart:

```text
Live Room 成员列表 (7cmc3yl3)
- 你 [p0bbdyyl] | local | Safe Local | (you)
- TX-server Claude [h63fa0wd] | remote_ssh | Safe Local | online | 水位 84% ok transcript
- TX-ET-SERVER Pi Agent [d9ybv9yi] | remote_ssh | Safe Local | online | 水位 87% ok transcript

Live Room 成员列表 (ne4syahb)
- 你 [f1zn1gpg] | local | Full Access | (you)
- codex [opaydgfg] | platform_local | Full Access | online | 水位 100% ! transcript
```

### 6. Web room UI updated

`src/components/live-room/LiveRoomWorkspace.tsx` now shows in the room member list:

- permission badge
- watermark percentage badge
- mini progress bar
- dominant reason label
- native tooltip with detailed counts

## Validation Done

### Passed

- focused `next lint` on all touched files passed
- Feishu `/ap members` showed the new watermark output after service restart
- web room UI should now render the new badges/progress bar from enriched member payloads

### Known unrelated repo issue

`npx tsc --noEmit` still fails because of a pre-existing issue in:

- `src/lib/feishu-live-room.ts:609`

This session did not change that file.

## Main Product/Modeling Observations

### A. The watermark is useful, but still heuristic

It is currently a platform-side approximation based on:

- visible task-room message count
- task run event count
- prompt transcript character length

It is **not** real model token usage.

So the right claim is:

- good for operational comparison and reset decisions
- not a precise token-meter

### B. `84% ok` is the main UX problem surfaced in testing

This is the most important next polish item.

The current output is technically correct but operator-hostile.

The next session should decide one of these directions:

1. keep current backend thresholds, but separate:
   - percentage = "headroom used"
   - status = normal/warning/critical
2. or align UI warning colors/labels to percentage bands such as:
   - `<60%` safe
   - `60-80%` warning
   - `>80%` critical
3. or expose both:
   - `usage %`
   - `policy status`

Option 3 is the most explicit and least confusing.

### C. User member currently also shows permission label

Feishu output currently shows permission for the `你` row as well, because permission is taken from the room source task profile.

That is defensible, but the next session may want to decide whether:

- permission should display only for reply-capable agent members
- or for every room row

## Recommended Next Session Priorities

### Priority 1. Fix watermark presentation semantics

Do this first before expanding the system further.

Suggested concrete work:

1. refactor `contextWatermark` to expose both:
   - `usagePercentage`
   - `policyStatus`
2. update Feishu `/ap members` wording so it no longer renders confusing combinations like `84% ok`
3. update web UI color semantics accordingly

### Priority 2. Add threshold-crossing proactive notifications

Recommended first:

- Feishu warning once on crossing warning threshold
- Feishu warning once on crossing critical threshold
- no per-message spam

This likely belongs in a lightweight room/member watermark state tracker, probably keyed by room/member plus last notified status.

### Priority 3. Then continue the structured bidirectional protocol work

After watermark semantics are solid, continue the next planned slice from `104`:

1. define explicit assistant-directed action payload
2. materialize a real intermediate room message
3. only trigger downstream member delivery from that explicit message
4. verify deterministic `A -> B -> A`

## Suggested Bootstrap For Next Session

Read in this order:

1. `docs/105_LIVE_ROOM_MEMBER_WATERMARK_SLICE_HANDOVER.md`
2. `docs/104_AGENT_BIDIRECTIONAL_AND_CONTEXT_WATERMARK_NEXT_HANDOVER.md`
3. `docs/95_CONTEXT_WATERMARK_PLAN.md`
4. inspect:
   - `src/lib/task-room.ts`
   - `src/lib/live-room.ts`
   - `src/lib/feishu.ts`
   - `src/components/live-room/LiveRoomWorkspace.tsx`

## Short Takeaway

This session successfully landed the first visible per-member watermark slice and proved it through Feishu after service restart.

The next agent should not redo the aggregation work.
The immediate next value is to fix watermark semantics/presentation, especially the `84% ok` mismatch, then add proactive threshold warnings, then resume hard-structured bidirectional room protocol work.
