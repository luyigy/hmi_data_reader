# 63 Feishu Harness Approval Bridge Plan

## Date
2026-04-05

## Goal

Add a real approval bridge so Feishu can handle harness requests such as:

- permission approval
- confirmation / deny
- free-form input
- choice selection

and do it in a harness-agnostic way that can support:

- Codex
- Claude Code
- future local or remote harnesses

The target is not “Feishu approval for Codex only”.

The target is:

- one unified interactive request model in ACPX
- Feishu as one approval client
- web UI / terminal as future parallel approval clients

## Why A Plan Is Required

This feature crosses:

- runner lifecycle
- harness adapter contracts
- persistence and audit
- Feishu command UX
- security and approver identity
- resume semantics for multiple harnesses

If implemented directly inside `feishu.ts` or one harness adapter, the result will be:

- Codex-specific branches everywhere
- incompatible behavior across Codex / Claude / others
- no stable protocol for future approval clients

## Current State

Relevant existing pieces already in repo:

- `TaskRun.status` includes `waiting_for_input`
- `RunActivityState` includes `waiting_user`
- `HarnessInteractionRequestKind` already exists in `src/lib/acpx/types.ts`
- task room control model already exists for:
  - `queue_message`
  - `interrupt_now`
  - `stop_run`
  - `continue_session`

What is still missing:

- a persisted approval/input request model
- harness adapters emitting normalized request events
- Feishu commands to approve / deny / answer
- runner resume path after approval

## Product Scope

### In Scope

- pending approval cards/messages from Feishu
- user actions:
  - approve
  - deny
  - answer input
  - choose option
- Codex first implementation
- adapter design that Claude Code can plug into next
- persistent audit trail

### Out Of Scope For Phase 1

- arbitrary rich Feishu interactive cards
- partial token-stream interposition
- multiple simultaneous approvers with quorum logic
- non-Feishu auth federation

## Core Design Decision

Introduce a new ACPX-level interaction request object that sits above harness-specific stdout/stderr parsing.

Harnesses should not talk to Feishu directly.

Instead:

1. harness adapter detects a request
2. adapter emits normalized interaction request
3. runner persists it
4. runner marks participant / run as waiting
5. Feishu command layer reads pending requests and responds
6. runner resumes harness with the selected answer

## Data Model

Recommended new table:

### `TaskRunInteractionRequest`

Fields:

- `id`
- `taskId`
- `taskSessionId`
- `taskRunId`
- `participantId`
- `roomMessageId` nullable
- `source`
  - `harness`
  - `system`
- `requestKind`
  - `permission_request`
  - `input_request`
  - `choice_request`
  - `workspace_issue`
- `status`
  - `pending`
  - `approved`
  - `denied`
  - `answered`
  - `expired`
  - `cancelled`
- `title`
- `message`
- `rawPayload`
  - raw harness event snapshot
- `optionsJson`
  - normalized options for choice requests
- `defaultAnswer`
- `responseText`
- `responseMetadata`
  - approver identity, channel, timestamps, extra details
- `requestedAt`
- `resolvedAt`
- `expiresAt`
- `createdAt`
- `updatedAt`

Indexes:

- `taskRunId, createdAt`
- `participantId, status`
- `status, expiresAt`

## Normalized Interaction Contract

Extend the harness adapter contract to emit a richer structure than the current lightweight `HarnessInteractionRequest`.

Recommended shape:

```ts
type HarnessInteractionEnvelope = {
  kind: 'permission_request' | 'input_request' | 'choice_request' | 'workspace_issue';
  title: string;
  message: string;
  rawContent: string;
  options?: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  defaultOptionId?: string | null;
  resumeStrategy: 'in_process' | 'rerun_continuation' | 'restart_required';
  responseFormat: 'approve_deny' | 'text' | 'single_choice';
};
```

Key point:

- the harness adapter defines how the request should be answered
- the runner does not need to understand Codex- or Claude-specific stdout format

## Harness Strategy

### Phase 1: Codex

Codex is first because it already has:

- session continuation model
- live room integration
- practical Feishu usage pressure

Needed work:

- detect approval/input request events from Codex output
- convert them into normalized interaction envelopes
- pause participant state
- support resuming same Codex process if possible

If true in-process response is not possible in first iteration, fallback is:

- persist request
- once approved, continue via `continue_session` / resumed thread with explicit approval outcome in prompt

That fallback is less elegant but acceptable for phase 1 if documented.

### Phase 2: Claude Code

Add a Claude adapter that maps its request prompts into the same normalized interaction envelope.

Important:

- do not special-case Feishu at adapter level
- only adapter -> ACPX interaction object

### Phase 3: Other Harnesses

For OpenCode or future harnesses:

- implement the same adapter contract
- declare capability:
  - supports interactive requests or not
  - supports in-process resume or not

## Capability Model

Add or extend per-harness capability declaration with:

- `supportsInteractionRequests`
- `supportsInteractiveApproval`
- `supportsInteractiveTextInput`
- `supportsInteractiveChoiceInput`
- `supportsInProcessResumeAfterInput`

This is necessary because:

- some harnesses can accept stdin and continue
- some can only be resumed by starting a new continuation turn
- some may only expose passive warnings

## Runner Lifecycle

### When a harness raises a request

Runner should:

1. persist `TaskRunInteractionRequest`
2. set participant `activityState = waiting_user`
3. set run `status = waiting_for_input` when the blocked participant is the active one
4. publish a live event
5. optionally post a task room / live room system message

### When user responds

Runner should:

1. validate requester authorization
2. atomically mark request resolved if still pending
3. apply harness-specific resume strategy
4. emit live event:
   - approved
   - denied
   - answered
5. move run/participant out of `waiting_user` if resume succeeded

### Expiration

Requests should expire automatically after a configurable TTL.

On expiry:

- request status becomes `expired`
- run may become:
  - `failed`, if harness cannot continue
  - or remain paused, if manual intervention is allowed

Phase 1 recommendation:

- expire and fail with explicit reason after timeout

## Feishu UX

### Notification format

Plain text first, not cards.

Example:

```text
系统提示：Codex 请求授权
Approval ID: apv_123456
类型：permission_request
原因：需要联网访问外部 API
操作：
/ap approve apv_123456
/ap deny apv_123456
```

For input request:

```text
系统提示：Claude 请求用户输入
Approval ID: apv_123456
问题：请选择部署环境
可选项：staging, production
操作：
/ap answer apv_123456 staging
```

### Feishu commands

Recommended first set:

- `/ap approvals`
  - list current pending requests for current room / bound task
- `/ap approve <id>`
- `/ap deny <id>`
- `/ap answer <id> <text>`

Optional later:

- `/ap approvals --all`
- `/ap approvals --run=<id>`

## Authorization Model

Phase 1 should be conservative.

Recommended rule:

- only the Feishu user who initiated the current room/task session can approve by default
- allow an explicit admin allowlist later

At minimum, persist:

- Feishu `senderOpenId`
- sender display name if available
- source channel:
  - `feishu`
  - `web`
  - `terminal`

## API / Command Surface

### Backend

Recommended additions:

- interaction request service:
  - create pending request
  - list pending requests
  - resolve request
  - expire stale requests
- runner hooks:
  - `pauseForInteractionRequest(...)`
  - `resumeFromInteractionRequest(...)`

### Feishu commands

Implement in `src/lib/feishu.ts`:

- `/ap approvals`
- `/ap approve`
- `/ap deny`
- `/ap answer`

## Proposed Phases

### Phase 1. Design + persistence

- add Prisma model
- add service layer
- add task run event types if needed
- no Feishu wiring yet

### Phase 2. Codex adapter

- detect Codex interactive requests
- persist pending requests
- mark run waiting
- add minimal task room event output

### Phase 3. Feishu approval commands

- `/ap approvals`
- `/ap approve`
- `/ap deny`
- `/ap answer`
- resolve request and resume run

### Phase 4. Claude Code adapter

- map Claude requests into same interaction model
- reuse Feishu commands and persistence unchanged

### Phase 5. Web approval client

- pending approval panel in `/tasks/[id]/chat`
- same backend objects, same resolution flow

## Risks

### 1. Harness resume may differ materially

Codex and Claude may not support the same “pause and answer” semantics.

Mitigation:

- normalize request persistence
- allow per-harness `resumeStrategy`

### 2. Feishu messages are low-bandwidth UI

Long option lists or complex prompts will be awkward in text.

Mitigation:

- plain text in phase 1
- cards only after protocol stabilizes

### 3. Race conditions on approval

Two approvers may attempt to resolve the same request.

Mitigation:

- atomic “pending -> resolved” transition
- loser gets “already resolved” reply

### 4. Security mistakes

Approval authority cannot be “anyone in chat” by default.

Mitigation:

- explicit authorization checks from day one
- audit fields mandatory

## Recommended First Implementation Slice

The smallest correct slice is:

1. add `TaskRunInteractionRequest`
2. create a runner service for pending interaction requests
3. wire Codex request detection to that service
4. expose `/ap approvals`, `/ap approve`, `/ap deny`, `/ap answer`
5. resume Codex using continuation if true in-process response is not yet feasible

This gives immediate value in Feishu while preserving the correct abstraction for Claude next.

## One-Line Conclusion

Build a single ACPX interaction-request layer first, then plug Feishu, Codex, and Claude into it, instead of implementing a Codex-only Feishu permission shortcut.

