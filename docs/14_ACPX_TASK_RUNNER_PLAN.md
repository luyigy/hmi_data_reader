# 14 ACPX Task Runner Plan

## Date
2026-03-23

## Goal
Build a real ACPX task runner entry and a live progress view for gateway-scoped coding harness output inside Agent Platform.

This phase should let a user:
- create a coding task through a clear ACPX entry
- choose which gateway + harness combination(s) to use
- watch the task progress live in the app
- review final summary, errors, and modified files after completion

## Why This Needs A Plan
This work is not just a UI tweak. It crosses:
- task entry UX
- task execution orchestration
- child-process / harness integration
- persistence for run state and event logs
- live event delivery to the frontend
- task detail / chat / console UX

Without a plan, it is easy to build another partial demo that only stores final output and does not support real live progress.

## Current State

### What already exists
- Tasks can be created and assigned to agents.
- Tasks can be executed through `/api/tasks/[id]/execute`.
- There is a task detail page and a task chat/progress page.
- Real Codex and Claude integrations exist in:
  - `src/lib/real-agents/codex-agent.ts`
  - `src/lib/real-agents/claude-agent.ts`
- The task chat/progress page already exists at:
  - `src/app/tasks/[id]/chat/page.tsx`

### What is still missing
- No explicit ACPX entry or mode in the product.
- No first-class way to choose `gateway + harness`.
- Current execution routing is largely name-based, not a real runner contract.
- Current Codex / Claude integration buffers stdout / stderr and returns a final blob at process end.
- Current task progress is polling-based and result-based, not true live harness streaming.
- No dedicated persisted task-run event model yet.
- No model for per-gateway harness capability discovery.

## Product Decision For This Phase

### Recommended shape
Use ACPX as a platform-owned coding task runner mode, not just another ordinary agent name.

That means:
- the user creates a task in an ACPX mode
- ACPX decides which harnesses to invoke
- the task gets a dedicated live console
- task events are stored independently from generic chat messages

### Why this is better
- avoids brittle name-based dispatch
- gives us a stable backend contract
- makes live progress easier to implement cleanly
- keeps room for later expansion to more harnesses

### Explicit identity decision
For this phase, ACPX should **not** be identified by:
- agent display name
- a fuzzy string match like `name.includes('acpx')`
- existing Codex / Claude name-based routing

Instead, ACPX should be modeled as a **platform runner mode**.

That means:
- ACPX is not just another normal `Agent` row in the current system
- a task explicitly declares that it is running in `acpx` mode
- the task declares one or more ACPX participants
- each participant binds:
  - gateway
  - harness
  - role

### Current limitation in the codebase
Right now, the codebase does not have a reliable ACPX identity marker.

Current behavior is still largely inferred from assigned agent names, especially for:
- `codex`
- `claude`

This is acceptable as legacy behavior, but it should not be the foundation for ACPX.

### Planning implication
The next implementation should add an explicit ACPX marker at the task/run level.

Recommended direction:
- add a task execution mode such as:
  - `standard`
  - `acpx`
- add explicit ACPX participant selection instead of one flat runner target
- each participant should specify:
  - `gatewayId`
  - `harnessType`
  - `role`

This is preferred over introducing a fake normal agent whose identity is “ACPX”.

### Multi-gateway requirement
The platform must support cases like:
- Linux gateway `codex` for one task
- Windows gateway `codex` for another task
- Linux `codex` for implementation + Windows `claude` for review
- future harnesses such as `gemini-cli`

So ACPX cannot be modeled as just:
- `codex`
- `claude`
- `all`

It must be modeled as orchestration over **gateway-scoped harnesses**.

## Revised Product Requirement

### What the user actually needs
The user may want to:
- choose the same harness on different gateways
- use several harnesses on the same task
- assign different responsibilities to different harnesses
- expand beyond Codex / Claude into other gateway-provided harnesses

Examples:
- `Linux / codex` does implementation
- `Windows / claude` does review and test
- `Linux / gemini-cli` does research or extraction

### Product implication
The ACPX task creator should evolve from a single `Runner 目标` dropdown into a participant-based configuration UI.

Recommended modes:

#### Mode A: simple single-runner
For quick tasks:
- choose one gateway-scoped harness

Examples:
- `Linux Gateway / codex`
- `Windows Gateway / codex`
- `Windows Gateway / claude`
- `Linux Gateway / gemini-cli`

#### Mode B: workflow mode
For orchestrated work:
- add multiple participants
- assign each a role

Example:
- `planner` -> `Linux / claude`
- `implementer` -> `Linux / codex`
- `reviewer` -> `Windows / claude`
- `tester` -> `Windows / gemini-cli`

## Phase 1 Scope
Keep the first implementation intentionally narrow.

### In scope
- one ACPX task entry in the tasks UI
- gateway-scoped harness selection
- at least one participant row
- participant fields:
  - `gateway`
  - `harness`
  - `role`
- persisted run record and run events
- live output console for a task run
- final summary and status
- basic modified-file extraction if available

### Out of scope
- retries and resume
- approval workflows
- file diff viewer
- artifact downloads
- deep multi-agent planning within ACPX
- task cancellation / pause / resume
- replaying old runs as a fully reconstructed terminal
- complex DAG workflow editing
- automatic dependency graph planning
- rich template library for roles

## Proposed User Experience

### Entry
Add a dedicated ACPX task creation path in the task page.

Recommended UX:
- keep the existing task page
- add an ACPX-focused creation option:
  - task name
  - task description
  - one or more participant rows
  - each row contains:
    - role
    - gateway
    - harness
  - optional working directory

### Harness dropdown behavior
The harness picker should not be global.

It should show values like:
- `Linux Gateway / codex`
- `Windows Gateway / codex`
- `Windows Gateway / claude`
- `Linux Gateway / gemini-cli`

This is how the user differentiates the same harness on different gateways.

### Execution
When the user starts the task:
- the task moves to `running`
- a `TaskRun` record is created
- one or more participants are attached based on explicit gateway + harness + role selection
- the backend begins streaming events as the harness executes

### Viewing progress
The primary live view should be `/tasks/[id]/chat`, upgraded into a real execution console.

It should show:
- run start
- selected participant(s)
- harness start
- stdout chunks
- stderr chunks
- summary events
- file modified events
- completion / failure

If the task has multiple participants, the console should make clear:
- which gateway each event came from
- which harness emitted it
- which role that participant was assigned

### Final review
The task detail page should continue to show the structured summary:
- overall task status
- per-participant outcome
- final summaries
- modified files
- important errors

## Architecture Proposal

### High-level flow
```text
Tasks UI
   |
   v
Create ACPX Task
   |
   v
POST /api/tasks/[id]/execute   or a new ACPX-specific execute endpoint
   |
   v
ACPX Task Runner
   |
   +--> Gateway A / harness X / role 1
   +--> Gateway B / harness Y / role 2
   +--> Gateway C / harness Z / role 3
   |
   v
TaskRunEvent persistence
   |
   +--> WebSocket / SSE live delivery
   |
   v
/tasks/[id]/chat live console
```

### Recommendation on transport
Prefer WebSocket for phase 1 because the project already has websocket plumbing and chat message broadcasting.

Fallback:
- if websocket integration becomes messy, use SSE for task-run events only

### Recommendation on endpoint shape
Two reasonable options:

Option A:
- keep task creation generic
- add ACPX-specific metadata to the task
- execute through existing `/api/tasks/[id]/execute`

Option B:
- add ACPX-specific endpoint and keep generic tasks separate
- example:
  - `POST /api/tasks/[id]/acpx-run`

Recommended:
- use Option A for phase 1
- add explicit task execution mode metadata so the task system stays unified

## Data Model Proposal

### Existing models to keep using
- `Task`
- `Agent`
- `Gateway`

### New supporting concept

#### `GatewayHarnessCapability`
Represents which ACPX harnesses a gateway can spawn.

This can be implemented either as:
- a new database model
- or a JSON capability payload attached to `Gateway`

Suggested fields:
- `gatewayId`
- `harnessType`
  - `codex`
  - `claude`
  - `gemini-cli`
  - future harness types
- `displayName`
- `isAvailable`
- `metadata`

This is needed so the ACPX task UI can build a real gateway-scoped harness picker.

### New models to add

#### `TaskRun`
Represents one execution instance of a task.

Suggested fields:
- `id`
- `taskId`
- `mode`
  - `acpx`
- `status`
  - `pending`
  - `running`
  - `completed`
  - `failed`
- `startedAt`
- `completedAt`
- `summary`
- `error`

#### `TaskRunParticipant`
Represents each harness participant in the run.

Suggested fields:
- `id`
- `taskRunId`
- `gatewayId`
- `gatewayNameSnapshot`
- `harnessType`
- `role`
- `status`
- `startedAt`
- `completedAt`
- `summary`
- `error`
- `filesModified`

#### `TaskRunEvent`
Represents the live event stream.

Suggested fields:
- `id`
- `taskRunId`
- `participantId`
- `sequence`
- `eventType`
- `stream`
  - `stdout`
  - `stderr`
  - `system`
- `content`
- `metadata`
- `createdAt`

### Suggested event types
- `runner_started`
- `participant_started`
- `stdout_chunk`
- `stderr_chunk`
- `summary`
- `file_modified`
- `participant_completed`
- `participant_failed`
- `run_completed`
- `run_failed`

## Backend Execution Plan

### 1. Define the runner contract
Add a stable ACPX execution contract in code.

Recommended shape:
- `src/lib/acpx/types.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/event-writer.ts`

Suggested contract:
```ts
type TaskExecutionMode = 'standard' | 'acpx';

type AcpxHarnessType = 'codex' | 'claude' | 'gemini-cli';
type AcpxParticipantRole = 'planner' | 'implementer' | 'reviewer' | 'tester' | 'researcher';

interface AcpxParticipantRequest {
  gatewayId: string;
  harnessType: AcpxHarnessType;
  role: AcpxParticipantRole;
}

interface AcpxRunRequest {
  taskId: string;
  taskName: string;
  taskDescription?: string;
  participants: AcpxParticipantRequest[];
  workingDirectory?: string;
}
```

### 1.5 Define orchestration policy
For phase 1, support two execution styles:
- `single`
- `staged`

Recommended phase-1 interpretation:
- `single`: one participant
- `staged`: multiple participants executed in configured order

This is enough to support:
- planner -> implementer -> reviewer

It is better than a special hardcoded `all` mode.

### 2. Refactor Codex / Claude integration for streaming
Current integrations collect output into a string and return it only when the process closes.

Phase 1 change:
- expose chunk callbacks
- write chunks to `TaskRunEvent`
- broadcast chunks live to the client

Suggested callback shape:
```ts
onStdoutChunk?: (chunk: string) => Promise<void> | void;
onStderrChunk?: (chunk: string) => Promise<void> | void;
onEvent?: (event: HarnessEvent) => Promise<void> | void;
```

### 3. Persist events while running
Whenever a harness emits output:
- store a `TaskRunEvent`
- assign a monotonic sequence number
- broadcast to the task console channel
- include gateway + harness + role context in event metadata

### 4. Finalize status
At the end of the run:
- participant status is finalized
- run status is finalized
- task status is updated
- summary is written back to task result for overview pages

## Frontend Plan

### Tasks page
Add a visible ACPX creation path.

Recommended additions:
- ACPX toggle or dedicated button
- participant rows
- gateway selector
- harness selector
- role selector
- optional working directory field

### Task chat page
Upgrade it from a polling-based reconstructed timeline into a real live console.

Phase 1 display blocks:
- system timeline
- per-participant sections
- live text stream
- summary panel

### Task detail page
Keep this as the structured review page, not the main streaming surface.

It should emphasize:
- run overview
- per-participant result
- modified files
- duration
- final summary

## Delivery Plan

### Step 1
Write schema and backend contract.

Deliverables:
- Prisma schema changes
- ACPX runner type definitions
- event model
- gateway harness capability contract

### Step 2
Implement event persistence and live event broadcasting.

Deliverables:
- `TaskRun` creation
- `TaskRunEvent` persistence
- websocket channel for task-run events
- participant metadata included in live events

### Step 3
Refactor Codex / Claude harness execution to support chunk streaming.

Deliverables:
- chunk callbacks
- event writer integration
- final summary capture
- gateway / harness / role aware participant execution

### Step 4
Add ACPX task entry UX.

Deliverables:
- ACPX create-task form fields
- participant rows
- gateway + harness + role selector
- execution path wired through backend

### Step 5
Upgrade `/tasks/[id]/chat` into a true live console.

Deliverables:
- websocket subscription
- chunk rendering
- completion and error states
- clear gateway / harness / role labels on each event

### Step 6
Polish task detail summary view.

Deliverables:
- participant summaries
- modified files section
- better final result rendering

## Acceptance Criteria For Phase 1
- User can create a coding task through ACPX mode.
- User can choose gateway-scoped harnesses.
- User can distinguish `Linux / codex` from `Windows / codex`.
- Starting the task creates a persistent run record.
- Live output appears in the app while the harness is still running.
- Final task page shows success / failure and summary.
- Modified files are displayed when available.
- If multiple participants are configured, each participant’s result is visible separately.

## Main Risks

### 1. CLI output format instability
Codex / Claude output formats may vary.

Mitigation:
- treat stdout / stderr as raw stream first
- keep parsing minimal in phase 1

### 2. Long-running process lifecycle
Web request lifecycle may not be a safe place for long-running runs.

Mitigation:
- phase 1 can start in-process if acceptable
- if needed, quickly move to a background worker pattern after contract is defined

### 3. Sequence consistency
Interleaved output from multiple gateways / harnesses can become hard to read.

Mitigation:
- every event gets sequence and participant identity
- UI groups by participant while preserving order

### 5. Capability drift across gateways
Different gateways may not expose the same harnesses.

Mitigation:
- fetch gateway harness capability list before showing ACPX participant options
- validate capability again on execution

### 4. Scope creep
This feature can easily turn into a full job runner platform.

Mitigation:
- keep phase 1 narrow
- no retries, approvals, diffs, or replay features yet

## Recommended Build Start
Start with backend contract and event persistence first.

Why:
- the live console depends on stable event data
- the ACPX entry UX is easier once the contract exists
- Codex / Claude integration refactor becomes straightforward when there is a clear event writer target

## Practical Next Coding Order
1. add Prisma models for `TaskRun`, `TaskRunParticipant`, `TaskRunEvent`
2. add gateway harness capability discovery contract
3. build ACPX runner contract and event writer around participants
4. refactor Codex / Claude wrappers to emit chunks
5. wire task execution into ACPX participant mode
6. upgrade `/tasks/[id]/chat` to consume real live events
7. polish summaries on `/tasks/[id]`

## Decision Summary
Yes, a plan is necessary for this phase.

This document is the implementation plan to use for the next coding round.
The recommended first coding target is:
- backend event model
- runner contract
- chunk-streaming execution path

One additional explicit decision is now locked in:
- ACPX should be modeled as a platform execution mode, not inferred from an agent name and not treated as a normal agent identity.

And one more product decision is now locked in:
- ACPX must be gateway-aware and harness-aware.
- The UX should evolve from one flat runner dropdown into participant-based selection over `gateway + harness + role`.
