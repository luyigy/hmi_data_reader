# 45 Feishu Long Connection And Live Room Binding Handover

## Date
2026-03-28

## Overview

This round moved the platform Feishu integration from a minimal webhook-only prototype to a usable platform-owned Feishu entry with:

1. Feishu long connection support using `@larksuiteoapi/node-sdk`
2. Webhook security hardening kept in place as a fallback path
3. Feishu conversation binding to platform `Live Room`
4. Initial Feishu commands for room creation and ongoing room-bound chat

The key product shift is:

- Feishu is now no longer limited to one-shot command execution
- A Feishu chat can now bind to a platform `Live Room`
- Follow-up Feishu messages can be routed into the same room
- The room then reuses the platform's existing Live Room + ACPX reply pipeline

## What Was Implemented

### 1. Feishu long connection

New files:

- `src/lib/feishu-long-connection.ts`
- `src/instrumentation.ts`
- `src/app/api/feishu/connection/route.ts`

Behavior:

- Default mode is now `FEISHU_CONNECTION_MODE=long_connection`
- On server startup, the platform attempts to start a Feishu `WSClient`
- Incoming `im.message.receive_v1` events are handled through `EventDispatcher`
- The same command parsing and response path is reused for both webhook and long connection

Why this matters:

- The user only has `FEISHU_APP_ID` and `FEISHU_APP_SECRET`
- This avoids forcing immediate migration to webhook subscription settings
- This aligns more closely with the user's prior OpenClaw setup

### 2. Webhook security path was still improved

Updated files:

- `src/lib/feishu.ts`
- `src/app/api/feishu/webhook/route.ts`
- `.env.example`

Webhook path now supports:

- request signature validation
- encrypted payload decryption
- challenge handling
- `FEISHU_ENCRYPT_KEY`

This means webhook remains available as a future or fallback mode, but is no longer the only way in.

### 3. Feishu conversation -> Live Room binding

New files:

- `src/lib/feishu-live-room.ts`
- Prisma schema + migration for `FeishuConversationBinding`

Behavior:

- A Feishu chat can now bind to one platform `Live Room`
- First round command:
  - `/ap room --agents=<agentId1,agentId2> [--topic=xxx] [title]`
- Follow-up round command:
  - `/ap chat [--agents=<agentId1,agentId2>] <message>`

Implementation notes:

- Binding scope is:
  - `p2p` => one room per DM chat
  - `group` => one room per group chat
- Once bound, messages are written into the same `Live Room`
- Reply triggering is delegated to the existing Live Room auto-reply flow

### 4. Existing one-shot command flow was preserved

Still supported:

- `/ap help`
- `/ap status`
- `/ap gateways`
- `/ap agents <gatewayId>`
- `/ap chat --from=<gatewayId> --to=<gatewayId> ...`

This means the new room-bound Feishu behavior was added without removing the old cross-gateway one-shot command path.

## Validation Done

### Platform-side validation

- Server restarted with new code
- Long connection status endpoint returned:

```json
{"ok":true,"status":"running","startedAt":"2026-03-28T09:43:06.892Z","lastError":null,"mode":"long_connection"}
```

### Feishu-side validation

Observed:

- Platform replied to `/ap help`
- Platform replied to `/ap status`

This proves:

- app credentials were loaded correctly
- long connection was actually receiving events
- the platform was able to send Feishu replies back

### Conflict found and resolved

Initially both the platform and OpenClaw responded to the same bot.

Evidence:

- Platform command help text appeared
- OpenClaw-specific reply text also appeared:
  - `Agent failed before reply...`
  - `Logs: openclaw logs --follow`

Resolution:

- The bot was removed from the OpenClaw side
- This eliminated the duplicate responder problem

## Important Files

### Core Feishu files

- `src/lib/feishu.ts`
- `src/lib/feishu-long-connection.ts`
- `src/lib/feishu-live-room.ts`
- `src/app/api/feishu/webhook/route.ts`
- `src/app/api/feishu/connection/route.ts`
- `src/instrumentation.ts`

### Data model

- `prisma/schema.prisma`
- `prisma/migrations/20260328120000_add_feishu_conversation_bindings/migration.sql`

## Current Limitations

### 1. Users still need `/ap`

Current behavior still depends on command routing.

That means:

- group chat users still need `/ap ...`
- room-bound chat still requires `/ap chat ...`

This is the next product gap to remove.

### 2. Multi-agent visible discussion is not yet Feishu-native

Today:

- Feishu can bind into one `Live Room`
- `Live Room` can trigger multiple agents internally
- But Feishu does not yet present a rich multi-agent visible discussion experience

Missing pieces:

- natural no-prefix room chat after binding
- clear room participant roster in Feishu
- multi-agent transcript streaming back into Feishu
- visible turn-taking / discussion progress
- summary plus transcript formatting optimized for mobile Feishu reading

### 3. Binding persistence currently uses raw SQL access

The new `FeishuConversationBinding` table exists in Prisma schema and migration, but access in `src/lib/feishu-live-room.ts` currently uses `prisma.$queryRaw` / `prisma.$executeRaw`.

Reason:

- local Prisma client generation did not immediately expose the new delegate during this round

This is functional, but should be normalized later back to standard Prisma model access.

### 4. `FEISHU_BOT_OPEN_ID` is still optional but desirable

The current implementation works without forcing it, but it is still useful for:

- explicit self-message filtering
- safer reply loop avoidance

## Recommended Next Goal

The user's requested next target is correct:

- let users talk to the platform bot naturally without `/ap`
- let users really talk to multiple agents
- let users see their discussions

That should be implemented in this order.

### Phase 1: Remove `/ap` requirement after binding

Recommended behavior:

- If a Feishu chat is already bound to a `Live Room`, then:
  - any normal text message should be treated as room input
  - not only `/ap chat ...`

Suggested routing rule:

- If message starts with `/ap`, keep command mode
- Else if this Feishu chat already has a binding, route plain text into the bound `Live Room`
- Else in group chats:
  - require explicit bot mention or `/ap room`
- Else in DMs:
  - auto-create or prompt room creation

### Phase 2: Better Feishu room UX

Add:

- `/ap room` reply should include current room id/title/participants
- `/ap members` or equivalent room roster summary
- clearer reply text when a message was delivered to room but no agent was targeted
- guidance on how to mention room members from Feishu

### Phase 3: Multi-agent visible discussion back into Feishu

Target outcome:

- user asks one question in Feishu
- multiple agents discuss inside platform `Live Room`
- Feishu receives visible incremental discussion or structured periodic updates

Possible implementation options:

1. mirror selected `LiveRoomMessage` events back to Feishu
2. send only agent turns, not system noise
3. batch or debounce updates to avoid spam
4. end with summary + room link / transcript hint

### Phase 4: Make Feishu feel like a real mobile front-end

Later enhancements:

- reply cards / richer formatting
- room status cards
- pending reply indicators
- meeting start / finish cards
- better mobile transcript summaries

## Suggested First Task For Next Round

Implement this exact rule:

- If a Feishu chat already has a `FeishuConversationBinding`, then any non-`/ap` text message should be posted into the bound `Live Room` and trigger normal reply flow.

That is the fastest step that makes the Feishu experience feel real instead of command-line-like.

## Notes About Local Changes

During this round, local runtime files may also have changed:

- `.env`
- `prisma/dev.db`

These are local environment/runtime artifacts and should be handled carefully when committing.
