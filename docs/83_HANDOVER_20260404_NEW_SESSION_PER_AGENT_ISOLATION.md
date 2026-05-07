# 83 `/ap new-session` Per-Agent Isolation Handover

## Date

2026-04-04

## Summary

This document analyzes why `/ap new-session --handover="..." --profile=full "deepseek"`
resets context for **all agents** in a live room, rather than only the named target.

The design intent of `[agentName|idSuffix]` in the command signature is to scope the
reset to a single agent. The current implementation performs a **task-global** session
rotation that affects every agent sharing the same `Task`.

This is a design-level gap, not a simple bug. The existing infrastructure has per-member
tracking (`LiveRoomMemberSession`) but the core session/context logic is task-wide.

## Background: What `81` Already Fixed

Document `81_FEISHU_NEW_SESSION_SCOPE_RESET_HANDOVER.md` introduced:

- `rotateTaskSession()` — creates a fresh `TaskSession` and replaces `Task.currentTaskSessionId`
- `postTaskRoomSessionResetMarker()` — writes a global `TASK_ROOM_SESSION_RESET:...` marker
- Session-scoped event counting in `checkContextWatermark()`
- Session-scoped continuation lookup in `findLatestParticipantSession()`

Before `81`, `/ap new-session` didn't rotate sessions at all — the agent got a fresh run
but still saw the old overloaded task-room transcript.

After `81`, the session rotation works, but it was intentionally made **task-global**:
one `TaskSession` → one `Task.currentTaskSessionId` → shared by all agents.

## The Gap: Task-Global vs Per-Agent

### Current Data Flow

```
/ap new-session --handover=docs/xx.md --profile=full "deepseek"

  handleNewSessionCommand() in src/lib/feishu.ts:

  1. resolveRoomMemberQuery(room, "deepseek")  → finds deepseek's LiveRoomMember
                                                   ✓ per-agent targeting

  2. rotateTaskSession(room.sourceTask.id, ...)
     → creates NEW TaskSession
     → Task.currentTaskSessionId = NEW
       ⚠ TASK-GLOBAL: all agents now share this session

  3. postTaskRoomSessionResetMarker(...)
     → writes TASK_ROOM_SESSION_RESET:{sessionId}:new-session:{memberId}
       ⚠ GLOBAL marker: sliceMessagesAfterLatestSessionReset() sees it for ALL agents

  4. postTaskRoomMessage(targetType='participant', targetParticipantKey=deepseek)
     → message is addressed to deepseek
       BUT buildTaskRoomPromptContext() does NOT filter by targetType
       → ALL agents see this message in their context

  5. executeAcpxTaskRun(taskSessionId=freshTaskSession.id, participants=[deepseek])
     → spawns deepseek run on new session
     → but when OTHER agents connect later, ensureTaskSession() returns same session
```

### Where It Breaks for Other Agents

When agent "claude" connects after `/ap new-session "deepseek"`:

```
runner.ts → ensureTaskSession(taskId)
  → Task.currentTaskSession (the one created for deepseek)
  → all agents share same session ✓ from implementation perspective
  → but ✗ from user intent

task-room.ts → buildTaskRoomPromptContext(taskId, taskName)
  → getTaskRoomMessages() → all messages
  → sliceMessagesAfterLatestSessionReset() → cuts at the GLOBAL reset marker
  → includes messages targeted at deepseek (targetType='participant')
  → transcript is scoped to post-reset messages only
  → claude loses ALL pre-reset history
```

### Key Code Locations

**session.ts:135 — `rotateTaskSession`**
```typescript
export const rotateTaskSession = async (taskId, options) => {
  const session = await prisma.taskSession.create({ ... });
  await prisma.task.update({
    where: { id: taskId },
    data: { currentTaskSessionId: session.id },  // ← single session per task
  });
  return session;
};
```

**task-room.ts:219 — `sliceMessagesAfterLatestSessionReset`**
```typescript
const sliceMessagesAfterLatestSessionReset = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTaskRoomSessionResetMarker(messages[i])) {
      return messages.slice(i + 1);  // ← global cut, no agent filtering
    }
  }
  return messages;
};
```

**task-room.ts:145 — `buildTaskRoomPromptContext`**
```typescript
const contextMessages = sliceMessagesAfterLatestSessionReset(messages)
  .filter(shouldIncludeTaskRoomPromptMessage);
// ← no filtering by targetType or targetParticipantKey
```

## Existing Per-Member Infrastructure (Not Yet Used for Session Isolation)

`LiveRoomMemberSession` model already tracks per-member state:

```
model LiveRoomMemberSession {
  id          String
  roomId      String
  memberId    String     // ← per-member
  sessionKey  String
  threadId    String?    // ← per-member thread
  status      String     // online, offline, busy, expired
  ...
}
```

`handleNewSessionCommand` already updates it for the target member:
```typescript
await prisma.liveRoomMemberSession.updateMany({
  where: { roomId: room.id, memberId: member.id },
  data: { threadId: null, status: 'online', lastError: 'reset_by_new_session', ... },
});
```

But this per-member session tracking is NOT used by:
- The context building path (`buildTaskRoomPromptContext`)
- The session resolution path (`ensureTaskSession`)
- The reset-marker slicing logic

## What Would Per-Agent Isolation Require

Three layers need changes:

### Layer 1: Per-Agent TaskSession (or equivalent)

Option A: Add `memberId` to `TaskSession` — each agent gets their own row.

Option B: Use `LiveRoomMemberSession` as the authoritative per-agent session,
keeping `TaskSession` for task-wide coordination only.

Either way, `ensureTaskSession()` / `executeAcpxTaskRun()` need to resolve
the correct session per participant, not just per task.

### Layer 2: Per-Agent Session Reset Marker

The `TASK_ROOM_SESSION_RESET:...` marker needs a `memberId` or `participantKey`
component. `sliceMessagesAfterLatestSessionReset()` should only cut messages for
the agent whose reset marker matches.

Alternative: store per-member "last reset message id" instead of using a global
marker scan.

### Layer 3: Per-Agent Transcript Scoping

`buildTaskRoomPromptContext` currently returns ALL messages after the reset point.
It needs a `participantKey` parameter and should filter:

- Include: messages with `targetType: 'task'` or `targetType: 'all'` (global)
- Include: messages with `targetType: 'participant'` AND matching `targetParticipantKey`
- Exclude: messages addressed to OTHER participants

The `Message` model already has `targetType`, `targetParticipantKey`, and
`targetParticipantLabel` fields — the data is there, the filtering logic is
just not applied.

## Files Involved in a Fix

| File | Current Behavior | Needed Change |
|------|-----------------|---------------|
| `src/lib/acpx/session.ts` | `rotateTaskSession` → task-global | Per-agent session rotation |
| `src/lib/task-room.ts` | `buildTaskRoomPromptContext` no participant filter | Accept & filter by participant key |
| `src/lib/task-room.ts` | `sliceMessagesAfterLatestSessionReset` global | Per-agent reset marker or last-reset-id |
| `src/lib/task-room.ts` | `postTaskRoomSessionResetMarker` global | Include member/participant scope |
| `src/lib/acpx/runner.ts` | `ensureTaskSession(taskId)` task-global | Resolve per-participant session |
| `src/lib/feishu.ts` | `handleNewSessionCommand` already targets member | Plumb per-agent session to context paths |

## Recommendation

This is a design change, not a quick patch. Before implementing:

1. Confirm the desired UX: should `new-session` without an agent name reset ALL agents?
   Or should it require an explicit agent name? (Current behavior is the former — the
   agent name is optional in the help text.)

2. Decide session model: `TaskSession` + `memberId` vs `LiveRoomMemberSession` as
   primary.

3. Decide transcript model: per-agent message filtering vs per-agent ChatRoom.

The simplest incremental approach (lowest risk):

- Add `participantKey` parameter to `buildTaskRoomPromptContext` and filter messages
  by target type there.
- Store per-member "last reset at" timestamp (or message id) in `LiveRoomMemberSession`
  instead of using a global marker scan.
- Keep `TaskSession` as-is for task-wide coordination, but stop using it as the sole
  source of per-agent context scoping.

## Related Documents

- `docs/81_FEISHU_NEW_SESSION_SCOPE_RESET_HANDOVER.md` — prior fix that introduced
  task-global session rotation
- `docs/82_DEEPSEEK_PLATFORM_LOCAL_PHASE2A_HANDOVER.md` — DeepSeek Phase 2 context
- `docs/80_DEEPSEEK_PLATFORM_LOCAL_PHASE1_HANDOVER.md` — DeepSeek Phase 1 baseline
```

---

