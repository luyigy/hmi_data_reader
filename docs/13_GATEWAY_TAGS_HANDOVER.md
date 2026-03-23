# 13 Gateway Tags Handover

## Date
2026-03-23 11:14:35 CST

## What Changed
This checkpoint adds gateway identity to the task UI so agents with the same name can be distinguished reliably.

### UI updates
- Task creation modal now shows a gateway badge next to each agent.
- Task cards now show `agent name + gateway name` in assigned-agent chips.
- Task detail page now shows gateway info in the assigned-agent section.
- Task chat/progress page now shows gateway info in:
  - assigned-agent chips
  - the system message that lists assigned agents

### API/data updates
Gateway relation data is now included in task-related API responses so the UI can render gateway labels consistently.

Updated endpoints:
- `/api/tasks`
- `/api/tasks/[id]`
- `/api/tasks/[id]/logs`

## Files Changed
- `src/app/api/tasks/route.ts`
- `src/app/api/tasks/[id]/route.ts`
- `src/app/api/tasks/[id]/logs/route.ts`
- `src/components/tasks/TaskForm.tsx`
- `src/components/tasks/TaskCard.tsx`
- `src/app/tasks/page.tsx`
- `src/app/tasks/[id]/page.tsx`
- `src/app/tasks/[id]/chat/page.tsx`

## Behavior Now
- On the tasks page, duplicate agent names are no longer ambiguous because the gateway is visible.
- The gateway label comes from the agent's related `gateway` record.
- If an agent has no gateway, the UI falls back to `未分配网关`.

## Verification
Manual verification completed:
- Gateway tag displayed successfully in the task creation page/modal.
- Task-related views now have the data path needed to show gateway identity consistently.

Lint verification was attempted with `npm run lint`, but the repo already contains many pre-existing ESLint errors unrelated to this change. This checkpoint was not a lint-clean baseline before the edit.

## Important Notes For Next Phase
The next requested phase is:
- build the real ACPX task runner entry
- build a live progress view for Codex / Claude harness output

### Current status before that work
- Tasks can be created, assigned, and executed.
- Task detail and task chat/progress pages already exist.
- Current task progress is polling-based and result-based, not true live harness streaming.
- Real Codex / Claude execution exists in the codebase, but current UX is not yet a real ACPX dispatcher plus live stream viewer.

## Recommended Next Implementation Order
1. Define the ACPX runner contract.
   - Decide how a task chooses `codex`, `claude`, or `all`.
   - Decide whether ACPX is a special agent type, a special task mode, or both.
2. Introduce task-run event storage.
   - Persist per-step events and harness stdout/stderr chunks.
3. Stream task-run events from server to UI.
   - Prefer WebSocket or SSE over polling for harness output.
4. Upgrade `/tasks/[id]/chat` into a real live execution console.
   - Show step events, partial output, completion, errors, and touched files.
5. Add ACPX-specific entry UX.
   - A clear place to launch coding tasks through Codex / Claude / both.

## Suggested Data Shape For Next Phase
Consider introducing a task-run event model like:
- `TaskRun`
- `TaskRunParticipant`
- `TaskRunEvent`

Potential event types:
- `runner_started`
- `agent_selected`
- `harness_started`
- `stdout_chunk`
- `stderr_chunk`
- `tool_event`
- `file_changed`
- `summary`
- `run_completed`
- `run_failed`

This will make the live progress view much easier to build cleanly.
