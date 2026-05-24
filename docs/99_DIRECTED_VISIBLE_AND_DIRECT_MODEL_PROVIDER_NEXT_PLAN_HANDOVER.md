# 99 Directed Visible And Direct Model Provider Next Plan Handover

## Date

2026-05-24

## Purpose

This handover captures:

1. what is already completed in the existing room / ACPX / harness roadmap
2. what is still not completed
3. the recommended next implementation order
4. the current blocker status of remote `pi-agent`

The intended next session should read this file first and then start implementation directly.

## Current Summary

Current highest-priority product direction should be:

1. build `directed_visible` agent-to-agent messaging inside the same room
2. then add a new execution backend that talks to model providers by API instead of requiring local/remote CLI harnesses
3. keep remote `pi-agent` work out of the critical path unless the remote host is upgraded to a repo-wrapper runtime that matches local behavior

## What Is Already Landed

### 1. Live Room is already bridged into ACPX

From `38_ACPX_LIVE_ROOM_PLAN_C_BRIDGE_FOUNDATION_HANDOVER.md`, the major bridge foundation is already in code:

- each live room has a backing ACPX task
- room members map to ACPX participants
- live-room messages mirror into task-room / ACPX transcript context
- live-room replies already execute through ACPX single-participant runs
- continuation identity is no longer tied only to local codex

This means the next feature should extend the existing ACPX/live-room model, not build a parallel room runtime.

### 2. Mention / handoff / room routing foundation is already partially landed

From `30_ACPX_LIVE_ROOM_MENTION_AND_AGENT_TO_AGENT_HANDOVER.md` and `31_ACPX_LIVE_ROOM_BROADCAST_ALL_AND_MEMBER_VISIBILITY_HANDOVER.md`, the codebase already contains foundational routing semantics such as:

- structured mention metadata
- target-aware delivery resolution
- `handoff`
- `mention_all`
- `expectedResponderMemberIds`
- single-target lock for structured Feishu mention routing

So the system is no longer at the "everything is plain transcript text" stage.

### 3. Harness adapter framework is already the right extension point

From `88_HARNESS_ADAPTER_FRAMEWORK_DESIGN.md` and `89_HARNESS_ADAPTER_INTERFACE_DRAFT.md`:

- harness behavior is already abstracted behind `HarnessAdapter`
- local CLI harnesses are already registered through the adapter registry
- continuation / capability / permission support are already adapter-owned concepts

This is the correct insertion point for any future "direct model provider" backend.

### 4. Local `pi-agent` is valid; remote `pi-agent` is not

Confirmed again in this session:

- local `pi-agent` works through `/data1/code/pi-mono/pi-test.sh`
- local validated version is `0.74.0`
- remote host `TX-ubuntu2026` does **not** have `/data1/code/pi-mono/pi-test.sh`
- remote host instead runs `/home/ww/.local/node/bin/pi`
- that binary is `@mariozechner/pi-coding-agent@0.73.1`
- under platform non-interactive usage it returns legacy textual tool calls like:
  - `call:ls{path:.}`
  - `call:bash{command:...}`

This remote runtime is not behaviorally compatible with the local validated wrapper path.

## What Is Still Not Completed

### A. `directed_visible` room messaging is not implemented as a first-class message mode

The desired product behavior is:

- agent A can send a message specifically to agent B
- the message is still visible in the room timeline to the human operator
- only B treats it as actionable input
- other agents do not auto-respond as if it were a room broadcast

What exists today is only partial routing foundation.

What is still missing:

- an explicit room message visibility/routing mode for `directed_visible`
- UI markers such as `A -> B`
- composer / action entry points for an agent-originated directed message
- delivery rules that suppress non-target responders while preserving operator visibility
- audit semantics that distinguish:
  - `broadcast`
  - `mention`
  - `ask`
  - `handoff`
  - `directed_visible`

### B. direct model-provider execution is not implemented

The user wants a future mode where the platform can host participants backed directly by provider APIs, instead of only:

- `platform_local`
- `remote_ssh`
- `gateway_openclaw`

What is missing:

- a new backend type for provider-direct execution
- provider credential/config storage
- provider/model catalog exposure into room membership
- SSE/event normalization for non-CLI providers
- provider-backed continuation/session strategy
- a UI flow for adding "OpenAI / Anthropic / Gemini / DeepSeek / custom OpenAI-compatible" participants directly

### C. remote `pi-agent` is still operationally blocked

Code work in this session improved platform behavior:

- remote `pi-agent` now uses `--mode json` and explicit `--tools`
- legacy textual tool-call replies are no longer treated as successful room assistant messages
- instead they fail explicitly with a precise error

But the remote host runtime itself is still incompatible.

So remote `pi-agent` should be treated as:

- diagnosed
- partially guarded
- not truly fixed

## Existing Plan Docs: Done vs Not Done

### `97_REMOTE_PI_AGENT_AND_INTRA_ROOM_PRIVATE_CHAT_HANDOVER.md`

Status now:

- local `pi-agent` part: done
- remote `pi-agent` part: partially wired in platform, but still not operational
- intra-room private chat / visible directed chat: still not implemented

### `98_REMOTE_PI_AGENT_AND_FEISHU_TARGET_LOCK_HANDOVER.md`

Status now:

- remote SSH UI exposure for `pi-agent`: done
- remote executor branch for `pi-agent`: done
- Feishu single-target lock: done
- remote `pi-agent` real usability: still not done because host runtime is wrong

### `30_ACPX_LIVE_ROOM_MENTION_AND_AGENT_TO_AGENT_HANDOVER.md`

Status now:

- structured mention / target metadata foundation: partially done
- routing priority model: partially done
- true agent-to-agent directed protocol: not done
- explicit `directed_visible` product mode: not done

### `31_ACPX_LIVE_ROOM_BROADCAST_ALL_AND_MEMBER_VISIBILITY_HANDOVER.md`

Status now:

- `mention_all` / room-wide semantics foundation: partially done
- complete fan-out / staged room-wide response policy: not fully done
- richer member-visibility / roster UX still incomplete

### `28_ACPX_CROSS_GATEWAY_REALTIME_DIRECT_DELIVERY_HANDOVER.md`

Status now:

- live delivery/session thinking influenced later architecture
- full participant-level realtime inbox for general task-room participants is still not complete
- the next room feature should reuse the same delivery/audit ideas, not restart from scratch

### `88` + `89` Harness Adapter docs

Status now:

- adapter architecture is the correct basis and is already in use
- next "direct model provider" work should follow this path instead of inventing another bespoke runtime path

## Recommended Next Implementation Order

### Phase 1. Implement `directed_visible`

This should be the next real build target.

Why first:

- it is directly aligned with the user’s room-collaboration goal
- the room already has most of the routing substrate needed
- it improves both human-to-agent and agent-to-agent meeting behavior
- it does not require external provider/account plumbing first

Recommended scope:

1. add explicit message intent / visibility values
   - add `directed_visible` into room metadata semantics
2. add delivery rules
   - only the target member receives actionable delivery
   - message remains visible in timeline
3. add UI representation
   - show `sender -> target`
   - show a directed/private-visible badge
4. add agent-originated support
   - an agent message can deliberately target another agent
5. keep audit intact
   - room transcript remains the source of truth
   - delivery records clearly show target + outcome

Likely code areas:

- `src/lib/live-room.ts`
- `src/lib/live-room-delivery.ts`
- `src/lib/feishu-live-room.ts`
- live room / workspace message UI components
- composer / message metadata handling

### Phase 2. Add provider-direct backend

After `directed_visible`, the next major feature should be a new backend for direct provider/API participants.

Recommended architecture:

- do **not** fake this as another local CLI harness
- introduce a new backend class alongside existing ones
- keep harness adapter semantics where useful, but separate "backend transport" from "model/provider adapter"

Recommended first version:

1. support OpenAI-compatible streaming API first
2. then layer Anthropic-style adapter
3. then optionally Google / DeepSeek / custom provider variants

Minimal product slice:

- add provider configs:
  - label
  - provider type
  - base URL
  - API key ref/encrypted secret
  - model id
- expose them as selectable room participants
- let them join the same room as CLI-backed agents
- normalize streamed text/tool-call events into existing room progress/event model

This should reuse ideas from:

- `88_HARNESS_ADAPTER_FRAMEWORK_DESIGN.md`
- `89_HARNESS_ADAPTER_INTERFACE_DRAFT.md`
- `docs/research/06_PROMAN_Adapter_多模型适配器实现详解.md`

### Phase 3. Revisit remote `pi-agent` only after runtime alignment

Do not spend the next main session trying to force the current remote `0.73.1` npm `pi` binary into correctness.

Instead, only resume remote `pi-agent` work when the remote host can provide a runtime equivalent to local validated behavior, ideally:

- a checked-out `pi-mono` repo
- a working wrapper like `pi-test.sh`
- verified `--mode json` tool execution events

## Concrete Next-Session Build Plan

If a new session is started from this handover, the recommended exact sequence is:

1. implement `directed_visible` metadata and delivery rules
2. add room timeline rendering for directed-visible messages
3. validate human-visible agent-to-agent communication in one room
4. write follow-up handover if the slice is large
5. only then start the provider-direct backend design/implementation batch

## Notes About This Session

This session changed platform behavior for remote `pi-agent` by making the failure mode explicit instead of silently letting legacy textual tool calls pollute the room transcript.

That is a worthwhile correctness improvement, but it should be understood as:

- diagnosis and guardrail
- not final feature completion

## Recommended Commit Scope

The next commit for this session should include only:

- the `remote pi-agent` executor/guardrail changes
- this handover document

It should not include unrelated local database, logs, Playwright artifacts, or other workspace noise.
