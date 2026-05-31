# 103 Feishu Runtime Recovery, DB Untrack, And Short Agent Selector Handover

## Date
2026-05-31

## Context

This batch started from an operational failure after worktree cleanup/restart:

- Feishu replies became unreliable
- some Feishu chats appeared to "lose" their live-room bindings
- the platform still had live rooms such as `CPSP_V1` and `CPSP部署2`, but binding state looked inconsistent

The important finding is that this was not primarily a source-code deletion problem.
It was a runtime-state persistence problem plus service startup drift.

Two separate issues were involved:

1. the two user services no longer loaded Feishu env consistently
2. `prisma/dev.db` was still a tracked Git file, so worktree cleanup/revert could roll back live runtime state

This document should be read together with:

- `docs/50_FEISHU_RELAY_AND_SSH_DIRECT_HARNESS_HANDOVER.md`
- `docs/61_FEISHU_RUNTIME_RECOVERY_AND_TYPING_RELAY_HANDOVER.md`
- `docs/101_FEISHU_NEW_BLANK_SESSION_AND_TASK_ROOM_RECENCY_HANDOVER.md`
- `docs/102_FEISHU_SERVICE_RECOVERY_LESSONS_20260531.md`

## What Was Confirmed

Runtime verification on 2026-05-31:

- `agent-platform-dev.service` was running
- `agent-platform-feishu.service` was running
- `GET /api/health` returned healthy
- `GET /api/feishu/connection` returned running standalone long-connection status

Database inspection showed:

- `LiveRoom` rows still existed
- `CPSP_V1` and `CPSP部署2` still existed and were `active`
- only a subset of `FeishuConversationBinding` rows remained

That strongly suggests earlier worktree cleanup/revert rolled `prisma/dev.db` backward, which made bindings look "deleted" even though the room records themselves were still there.

## Changes In This Batch

### 1. Shared local env fallback for both services

Added:

- `scripts/load-local-env.sh`

Updated both startup scripts to use the same fallback loader:

- `scripts/run-agent-platform-dev.sh`
- `scripts/run-feishu-runtime.sh`

Current fallback order:

1. `.env.feishu.local`
2. `.env.runtime.local`

This closes the previous drift where Feishu standalone runtime and Next dev server did not start with the same available Feishu credentials.

### 2. Runtime recovery notes documented

Added:

- `docs/102_FEISHU_SERVICE_RECOVERY_LESSONS_20260531.md`

That doc captures the exact failure mode seen on 2026-05-31:

- `Missing required environment variable: FEISHU_APP_ID`
- `attempt to write a readonly database`

### 3. Unbound Feishu DM now gives a correct binding hint

Updated:

- `src/app/api/feishu/webhook/route.ts`

Instead of replying with a stale hard-coded agent ID example, the webhook now:

- looks up current live-room catalog agents at runtime
- prefers local `codex` when available
- falls back to `/ap agents` guidance if needed

This fixes the earlier misdirection where the DM reply suggested a host-specific ID that did not match the current environment.

### 4. Short agent selectors now work in Feishu commands

Updated:

- `src/lib/feishu.ts`
- `src/lib/feishu-live-room.ts`

The following commands now accept short selectors, not only full catalog IDs:

- `/ap room --agents=TX-server:claude`
- `/ap add --agents=TX-server:claude`
- `/ap chat --agents=TX-server:claude ...`

Supported equivalent short forms:

- `TX-server:claude`
- `TX-server/claude`
- `claude@TX-server`

If a selector is ambiguous, the error now explains which agents it matched instead of only reporting unknown IDs.

### 5. Local runtime DB is no longer meant to be Git-tracked state

Updated:

- `.gitignore`

Added ignore rules for:

- `prisma/dev.db`
- `prisma/dev.db-*`

Also removed `prisma/dev.db` from Git index tracking in this batch.

This is the key operational fix. The live runtime database should not be vulnerable to `git restore`, worktree cleanup, or branch switching.

## Why This Matters For Feishu "Bidirectional Communication"

The old "双向通信" topic from doc `50` was about:

1. Feishu plain message -> bound live room
2. live-room assistant reply -> Feishu mirror

That path is now structurally present, but this batch exposed an important practical dependency:

If runtime env is inconsistent or the SQLite state is Git-reverted, the bidirectional loop looks broken even when the relay code itself is fine.

So this batch did not add a brand-new relay feature.
It repaired the operational foundation required for that relay loop to remain trustworthy.

## What Is Still Not Finished

There are two different "unfinished" layers:

### A. Operationally unfinished

We still need a deliberate verification pass for real Feishu multi-chat recovery:

1. list which Feishu chats/groups should still be bound
2. compare against `FeishuConversationBinding`
3. rebind missing chats with short selectors
4. verify reply mirror on each important room

This batch only fixed the platform so that future cleanup will not silently wipe that state again.

### B. Product/behaviorally unfinished: true bidirectional agent-to-agent loops

Per doc `101`, the bigger unfinished topic is still real bidirectional agent communication:

- A asks B
- only B executes
- B replies visibly
- A continues based on B's reply

Current system status:

- directed-visible relay exists in partial form
- target inference exists in partial form
- Feishu relay can display directed-visible messages
- but deterministic A -> B -> A ownership and continuation are still not complete

This batch did not solve that protocol problem.
It only improved addressability by making agent targeting shorter and less error-prone.

## Recommended Next Session

If starting a fresh chat, the next operator should do this in order:

1. Restart services if needed:

```bash
systemctl --user restart agent-platform-dev.service agent-platform-feishu.service
```

2. Verify runtime:

```bash
curl -sS http://127.0.0.1:3010/api/health
curl -sS http://127.0.0.1:3010/api/feishu/connection
```

3. Rebind missing Feishu rooms using short selectors, for example:

```text
/ap room --agents=TX-server:claude
/ap add --agents=TX-server:claude
```

4. Validate the basic Feishu bidirectional loop:

- send a plain non-`/ap` message in a bound Feishu chat
- confirm it appears in the bound live room
- confirm agent reply mirrors back to Feishu

5. Only after that, resume the larger agent-agent bidirectional design work from doc `101`.

## Files Changed In This Batch

- `.gitignore`
- `CLAUDE.md`
- `scripts/load-local-env.sh`
- `scripts/run-agent-platform-dev.sh`
- `scripts/run-feishu-runtime.sh`
- `src/app/api/feishu/webhook/route.ts`
- `src/lib/feishu.ts`
- `src/lib/feishu-live-room.ts`
- `docs/102_FEISHU_SERVICE_RECOVERY_LESSONS_20260531.md`

## Commit Guidance

Suggested commit theme for this batch:

- Feishu runtime recovery and DB safety
- short Feishu agent selectors
- updated handover notes

## Key Takeaway

The important lesson is not "Feishu binding logic is fragile".

The deeper problem was that live runtime state lived inside a Git-tracked SQLite file.
Once that file is tracked, normal Git cleanup behavior can masquerade as product-level deletion.

This batch fixes that operational trap and makes Feishu targeting significantly easier for humans, but the true bidirectional agent conversation protocol is still the next real design/implementation task.
