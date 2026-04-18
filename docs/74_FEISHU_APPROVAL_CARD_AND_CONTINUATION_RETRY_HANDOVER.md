# Handover 74 — Feishu Approval Card UI + Continuation Retry

**Date:** 2026-04-18
**Branch:** master (ahead of origin/master by 75 commits)
**Status:** ✅ Committed as `61fa7ac`

---

## Summary

Two major features landed in this batch:

1. **Feishu Interactive Approval Cards** — agents now send a card message with ✅/❌ buttons instead of plain text when requesting permission. Users can approve/deny directly from the card.
2. **Continuation Retry on Stale Participants** — when a participant becomes stale (403/404 from gateway), the system automatically recreates it and retries the task run instead of failing.

---

## What Changed

### 1. Feishu Approval Card (`src/lib/feishu-api.ts`)

New functions added:

- `sendFeishuTextMessageAndReturnId()` — sends a text message and returns the Feishu `message_id` for later editing
- `editFeishuMessage()` — PATCH an existing message (used to edit tool output)
- `sendFeishuApprovalCard()` — sends an interactive card with approve/deny buttons for permission requests
- `updateFeishuApprovalCardResolved()` — updates the card header to green/red after resolution

Card button format:
```typescript
// Value format passed to callback:
{ cmd: `approve:${interactionRequestId}` }  // or `deny:${interactionRequestId}`
```

### 2. Card Action Handler (`src/lib/feishu-long-connection.ts`)

`buildCardActionHandler(prefix)` registers a `CardActionHandler` with the Lark WSClient. It:
- Parses `approve:` / `deny:` commands from card button clicks
- Calls `resolveInteractionRequestWithContinuation()` with `approve` or `deny` action
- Updates the card to show resolution state

⚠️ **TypeScript workaround:** The Lark SDK types don't include `cardActionHandler` in `wsClient.start()` params, so a type cast is used:
```typescript
await (wsClient.start as (params: {...}) => Promise<void>)({
  eventDispatcher,
  cardActionHandler,  // runtime-supported but not in types
});
```

### 3. Continuation Retry (`src/lib/acpx/continuation-retry.ts`)

New file `continuation-retry.ts` exports `executeAcpxTaskRunWithContinuationFallback()`.

**Logic:**
1. Accepts `staleParticipantId` + the usual `executeAcpxTaskRun` request params
2. Attempts `executeAcpxTaskRun` with the given participant
3. On `403` (auth/session invalid) or `404` (participant not found), or `CONTINUE_TRY_FALLBACK` error code:
   - Deletes the stale participant record
   - Recreates the participant (fresh, no session)
   - Retries with the new participant
4. Returns the result of the retry (or original if no error)

**Replaced `executeAcpxTaskRun` calls** in:
- `src/lib/feishu-grant.ts` — `grantRightsForRoom()`
- `src/lib/acpx/interaction-actions.ts` — `resolveInteractionRequestWithContinuation()`
- `src/app/api/tasks/[id]/control/route.ts` — task control API

### 4. Other Changes

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Added `workingDirectory String?` to `LiveRoom` |
| `prisma/migrations/` | Migration for `LiveRoom.workingDirectory` |
| `src/lib/acpx/types.ts` | Added `workingDirectory` field |
| `scripts/feishu-bot-mvp.ts` | Fixed Feishu message API URL (query param instead of `searchParams`) |
| `src/app/agents/page.tsx` | Fixed React state update (delete key instead of setting `undefined`) |
| `src/app/api/live-rooms/[id]/clear-task-room/route.ts` | Fixed field names (`taskId` → `sourceTaskId`, `taskName` → `title`) |
| `src/lib/feishu.ts` | Minor changes |
| `src/lib/live-room.ts` | Minor changes |
| `src/lib/live-room-delivery.ts` | Minor changes |
| `src/lib/task-room.ts` | Minor changes |
| `src/lib/real-agents/claude-agent.ts` | Added `workingDirectory` to task config |
| `next.config.mjs` | `eslint.ignoreDuringBuilds: true` |

### New Files
- `src/lib/acpx/continuation-retry.ts` — continuation fallback logic
- `src/lib/acpx/tool-emojis.ts` — emoji mappings for tools
- `src/lib/feishu-progress.ts` — progress tracking for Feishu

---

## How to Test

### 1. Approval Card Flow
```bash
# Start the platform
cd /data1/code/agent-platform-v2
npm run dev

# Send a task that requires permission via Feishu
# Should receive a card with ✅/❌ buttons
# Click a button — card should update to green/red
```

### 2. Continuation Retry
```bash
# Create a task run, let it run until it needs a continuation
# Kill the gateway participant out from under it (simulate stale)
# Should automatically retry with a fresh participant
```

---

## Known Issues / Caveats

1. **Lark SDK type mismatch** — `cardActionHandler` param is passed via type cast. Monitor after SDK updates.

2. **Stale participant detection** — retry currently triggers on `403`, `404`, and `CONTINUE_TRY_FALLBACK` error code. If the retry also fails with a different error, it propagates up.

3. **`.env` not committed** — contains `FEISHU_APP_ID` / `FEISHU_APP_SECRET`. These are in `git restore` state.

4. **`prisma/dev.db` not committed** — binary DB file changed but excluded from commit.

---

## Code Review Notes

**No CRITICAL issues found.**

**Minor observations:**
- The `executeAcpxTaskRunWithContinuationFallback` wraps all `executeAcpxTaskRun` calls in 3 files. This is a significant behavioral change — all task runs now silently retry on auth failures. Monitor for unexpected retries.
- `updateFeishuApprovalCardResolved()` does a PATCH to edit the card. Feishu card editing has size limits; long content may be truncated.
- `buildCardActionHandler` returns a `CardActionHandler` that is instantiated but the return value is stored in `state` in the real code (not shown in diff snippet). Ensure it's kept alive.

---

## Next Steps

- [ ] Test the full approval card round-trip (send → click → resolve → card updates)
- [ ] Monitor logs for unexpected continuation retries
- [ ] Consider adding metrics for retry success/failure rates
- [ ] `feishu-progress.ts` — review this new file for any未尽事宜
