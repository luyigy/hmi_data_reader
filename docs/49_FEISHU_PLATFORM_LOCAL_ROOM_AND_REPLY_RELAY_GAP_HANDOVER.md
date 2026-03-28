# 49 Feishu Platform Local Room And Reply Relay Gap Handover

## Date
2026-03-29

## Final State At Handover

Feishu long-connection is running successfully in the standalone Node runtime.

The following are now verified working:

- `/ap help`
- `/ap gateways`
- `/ap agents`
- `/ap room` for a Feishu-bound room
- `/ap chat` writing into the bound live room
- platform-local room creation using this server's local `codex` and `claude`
- targeted routing for `@codex`, `@claude`, and `@all`

The main remaining gap is:

- agent replies generated inside the live room are **not yet relayed back to Feishu automatically**

This means Feishu currently receives:

- command acknowledgements
- room creation confirmations
- message accepted / routing acknowledgements

But Feishu does **not** yet receive:

- the actual assistant reply content produced later by live-room members

## What Was Fixed In This Session

### 1. Stale / misleading agent list output was corrected

Problems observed:

- dead platform-local agents from another host (`DESKTOP-5CN8JHA`) were still being shown
- old dummy agents (`Agent Alpha`, `Agent Beta`, etc.) polluted `/ap agents`
- Windows gateway agents were still shown as live even though that gateway was shut down

Fixes applied:

- hide foreign platform-local agents on this server
- delete dummy Alpha/Beta/Gamma/Delta/Epsilon/Zeta agent rows from local DB
- mark `gateway-win-10-0-8-3` and its agents offline in local DB
- keep Linux gateway agents visible as online based on current stored platform state

Result:

- `/ap agents` now shows:
  - local platform agents for this host
  - Linux gateway agents as online
  - Windows gateway agents as offline

### 2. Platform-local agents for this host are now bootstrapped into Feishu paths

Before the fix, this host had no `hostname=hello` platform-local agent rows in the DB.

That blocked Feishu room creation against local ACPX agents.

Fix:

- `ensurePlatformLocalAgents()` is now invoked in Feishu-facing list/catalog paths

Result:

- this server now has:
  - `platform-local:hello:claude`
  - `platform-local:hello:codex`

### 3. Room selection IDs for platform-local agents were identified

Important distinction:

- `/ap agents` shows DB/runtime-facing identifiers like `platform-local:hello:codex`
- `/ap room --agents=...` currently uses **live room catalog IDs**, not those DB IDs

Verified platform-local room catalog IDs:

- `platform_local:platform-local:codex`
- `platform_local:platform-local:claude`

Using these IDs successfully created / reused the Feishu-bound room.

### 4. Silent command failures were fixed

Previously, if `/ap room` or `/ap chat` failed inside the standalone long-connection runtime:

- the error was logged
- but Feishu got no visible reply

Fix:

- error replies are now sent back to Feishu for command failures in:
  - `src/lib/feishu-long-connection.ts`
  - `src/app/api/feishu/webhook/route.ts`

Result:

- failed commands now reply with visible error text instead of failing silently

### 5. `/ap chat` acknowledgement wording was clarified

Observed confusion:

- after `@codex hello`, Feishu sometimes showed `待回复成员：claude`
- after `@claude hello`, Feishu sometimes showed `待回复成员：codex`

This looked like misrouting, but actual delivery records proved routing was correct.

Root cause:

- the reply text showed the **room-wide pending queue**
- not the specific target(s) of the current message

Fix:

- `postFeishuMessageToBoundLiveRoom()` now returns:
  - `targetedMembers`
  - `mentionedAll`
  - `pendingReplies`
- Feishu acknowledgement now distinguishes:
  - current message target
  - room-wide pending members

Resulting reply format now includes lines such as:

- `本条消息目标：codex`
- `房间待回复成员：claude, codex`

## What Was Proven About Routing

Delivery records in live room `cmnaidsww0003g4iko9yckbmv` showed:

- `@codex hello` targeted `codex`
- `@claude hello` targeted `claude`
- `@all hello` targeted both `claude` and `codex`

So mention routing is functioning correctly for local platform agents.

## The Remaining Blocker

### Live-room assistant replies are not relayed back to Feishu

Verified behavior:

1. Feishu `/ap chat @all introduce yourself`
2. message is written to the live room
3. live room agents actually produce assistant replies
4. those assistant replies are stored in `LiveRoomMessage`
5. Feishu only receives the initial acknowledgement, not the assistant content

This was directly confirmed by checking `LiveRoomMessage` rows for room:

- `cmnaidsww0003g4iko9yckbmv`

Observed assistant replies existed in DB from `claude`, but Feishu did not receive them.

So the remaining architectural gap is:

- add outbound Feishu relay when a live-room assistant message is created for a Feishu-bound room

## Recommended Next Step

Implement Feishu outbound relay for live-room assistant messages.

Minimum direction:

1. detect when a live room has a `FeishuConversationBinding`
2. when an assistant message is appended to that room, send it to the bound Feishu chat
3. include sender identity in the forwarded text, e.g. `claude:` / `codex:`
4. avoid echo loops and duplicate sends

## Files Changed In This Session

- `src/app/api/feishu/webhook/route.ts`
- `src/lib/acpx/catalog.ts`
- `src/lib/feishu-live-room.ts`
- `src/lib/feishu-long-connection.ts`
- `src/lib/feishu.ts`

## Local-Only State Not For Commit

- `.env`
- `prisma/dev.db`

