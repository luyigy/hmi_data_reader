# 102 Feishu Service Recovery Lessons 2026-05-31

## Incident

After a worktree cleanup, the repo looked clean, but Feishu message flow was effectively broken:

- users could no longer reliably hear back from agents via Feishu
- `agent-platform-feishu.service` was running but failing stateful writes
- `agent-platform-dev.service` was running but missing Feishu outbound credentials

This was not a source-code deletion incident. It was a runtime startup-context incident.

## Observed Symptoms

- `journalctl --user -u agent-platform-feishu.service -n 200 --no-pager -o cat`
  showed repeated Prisma/SQLite write failures:
  - `attempt to write a readonly database`
- `journalctl --user -u agent-platform-dev.service -n 120 --no-pager -o cat`
  showed outbound relay failures:
  - `Missing required environment variable: FEISHU_APP_ID`
- repo worktree itself was clean
- database file still existed at `prisma/dev.db`

## Root Cause Pattern

Two service assumptions had drifted:

1. The standalone Feishu runtime already had a repo-local env fallback path.
2. The Next.js dev service did not load that same fallback.

So after cleanup removed or changed the older service-side env injection path, the two services no longer started with the same environment.

The practical result was:

- Feishu runtime could connect, but the overall message/state pipeline was unhealthy
- web-side relay back to Feishu failed because `FEISHU_APP_ID` was absent in the Next.js process

## Fix Applied

Shared env fallback loader added:

- `scripts/load-local-env.sh`

Startup scripts updated to use the same fallback logic:

- `scripts/run-agent-platform-dev.sh`
- `scripts/run-feishu-runtime.sh`

Current fallback order:

1. `.env.feishu.local`
2. `.env.runtime.local`

## Recovery Procedure

If Feishu suddenly stops relaying after cleanup, restart, or host changes:

1. Check service status:

```bash
systemctl --user status agent-platform-dev.service --no-pager
systemctl --user status agent-platform-feishu.service --no-pager
```

2. Check logs:

```bash
journalctl --user -u agent-platform-dev.service -n 120 --no-pager -o cat
journalctl --user -u agent-platform-feishu.service -n 200 --no-pager -o cat
```

3. If you see `Missing required environment variable: FEISHU_APP_ID`:

- verify `.env.feishu.local` or `.env.runtime.local` exists
- restart both user services

4. If you see `attempt to write a readonly database`:

- confirm `prisma/dev.db` still exists and is writable
- restart `agent-platform-feishu.service`
- then watch fresh logs only, not stale pre-restart lines

5. Verify runtime health:

```bash
curl -sS http://127.0.0.1:3010/api/health
curl -sS http://127.0.0.1:3010/api/feishu/connection
```

Expected recovery indicators:

- `/api/health` returns `{"ok":true,"status":"healthy",...}`
- `/api/feishu/connection` reports `status:"running"` and `runtimeOwner:"standalone_process"`

## Important Lesson

When this repo uses systemd user services, a “clean worktree” does not mean the runtime is healthy.

Always check:

- service environment loading
- user-service startup scripts
- fresh journal lines after restart
- Feishu runtime API health endpoint

Do not assume the failure is in Feishu command parsing or agent logic until service env and runtime health are verified first.
