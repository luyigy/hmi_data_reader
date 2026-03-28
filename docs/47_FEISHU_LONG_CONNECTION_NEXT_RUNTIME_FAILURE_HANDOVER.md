# 47 Feishu Long Connection Next Runtime Failure Handover

## Date
2026-03-28

## Final Conclusion

Feishu command handling is **working** when the long connection runs in a standalone Node process.

Feishu command handling is **not stable** when the same long connection is hosted inside the Next.js dev server runtime used by this project.

This means the main blocker is **not**:

- bot targeting
- `/ap help` command parsing
- Feishu message delivery in general
- `handleFeishuCommand()`
- `sendFeishuTextMessage()`

The blocker is the **Next.js-hosted long-connection runtime path**.

## What Was Proven

### 1. Rolled-back baseline still failed inside Next.js

The repo was hard-reset back to:

- `39c404b Add Feishu long connection and live room binding`

After restoring Feishu credentials in `.env`, the app came up and:

- `/api/feishu/connection` reported `status: "running"`

But Feishu commands still produced no user-visible reply.

### 2. Next.js runtime errors were captured directly

The rolled-back baseline still logged these errors inside the Next.js process:

- `TypeError: bufferUtil.mask is not a function`
- `Invalid access token for authorization. Please make a request with token attached.`

These errors happened on the Feishu websocket path while handling events.

### 3. Database mismatch was also present and was repaired

During rollback testing, the local SQLite database was behind the code and initially lacked:

- `FeishuConversationBinding`

Also, several older migrations had already taken effect in the DB but were still marked failed / unapplied in `_prisma_migrations`.

The migration state was repaired by resolving stale migrations and then applying:

- `20260328120000_add_feishu_conversation_bindings`

After that:

- `FeishuConversationBinding` exists in `prisma/dev.db`

This removed the DB/schema mismatch as a confounding factor.

### 4. Independent Node websocket test proved Feishu delivery works

A standalone smoke test script was created:

- `scripts/feishu-ws-smoke.js`

That script starts `@larksuiteoapi/node-sdk` `WSClient` outside Next.js.

It successfully received:

- `im.message.receive_v1`

This proved Feishu event delivery itself is fine.

### 5. Full standalone command loop proved end-to-end Feishu command handling works

A standalone monitor script was created:

- `scripts/feishu-standalone-monitor.js`

It reuses the project’s existing command logic directly:

- `parseFeishuCommand()`
- `handleFeishuCommand()`
- `sendFeishuTextMessage()`

It successfully handled and replied to:

- `/ap help`

Observed log sequence:

- command received
- command handled
- reply sent

This is the strongest evidence in the entire session.

## Practical Meaning

Current evidence says:

1. Feishu long connection itself can work
2. The platform’s command logic can work
3. Reply sending can work
4. The unstable piece is specifically the **Next.js-hosted Feishu long connection process**

So the correct architectural direction is:

- keep Next.js for app/web/API
- move Feishu long connection into a **standalone Node process**

## Files Added

- `scripts/feishu-ws-smoke.js`
- `scripts/feishu-standalone-monitor.js`

## Recommended Next Step

Promote the standalone monitor into the official Feishu runtime path.

Minimum follow-up:

1. add an npm script such as `feishu:monitor`
2. stop relying on `src/instrumentation.ts` + Next.js startup for Feishu websocket hosting
3. continue debugging `/ap room` only after Feishu long-connection hosting is moved to the standalone process

## Notes

- `.env` and `prisma/dev.db` were modified during investigation but are local environment state, not committed code changes.
- `prisma/dev.db-journal` may appear during SQLite writes; it is not part of the code change.
