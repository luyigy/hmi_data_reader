# 48 Feishu Standalone Runtime Success Handover

## Date
2026-03-28

## Final Result

Feishu long-connection is now running successfully as a standalone Node process.

Verified working from Feishu:

- `/ap help`
- `/ap agents`
- `/ap gateways`

This confirms the architectural fix from the previous handover:

- Next.js should host the web app and APIs
- the Feishu websocket long-connection should run in a separate standalone process

## What Changed

### 1. Standalone runtime became the official Feishu long-connection path

The previous investigation script:

- `scripts/feishu-standalone-monitor.js`

was promoted into the supported runtime entrypoint.

The official startup command is now:

```bash
npm run feishu:runtime
```

### 2. Feishu runtime logic was centralized

The standalone runtime now uses the shared implementation in:

- `src/lib/feishu-long-connection.ts`

This keeps the websocket event handling, command parsing, command execution, duplicate filtering, and reply sending in one place.

### 3. Next.js no longer hosts the Feishu websocket runtime

`src/instrumentation.ts` was intentionally reduced to a no-op for Feishu startup.

This removes the known-bad runtime path where Feishu long-connection was unstable inside the Next.js process.

### 4. Runtime status is now cross-process

A status file helper was added:

- `src/lib/feishu-runtime-status.ts`

The standalone worker writes runtime state to:

- `.runtime/feishu-long-connection.json`

The app API reads that status instead of relying on in-memory state inside Next.js.

This allows:

- `/api/feishu/connection` to report the real standalone worker state
- stale/dead worker detection via PID liveness checks

### 5. Proxy bypass is limited to the Feishu runtime only

The environment in this server session had proxy variables such as:

- `http_proxy`
- `https_proxy`
- `all_proxy`

pointing at:

- `127.0.0.1:1081`

That proxy broke the Feishu websocket connection.

The fix was applied only to the Feishu runtime script in `package.json`, so global proxy settings were not changed for the rest of the system.

## Verified Runtime Shape

For testing from outside the server:

1. start Next.js on `0.0.0.0:3010`
2. start the standalone Feishu runtime
3. confirm:

```json
{"ok":true,"status":"running","mode":"long_connection","host":"standalone"}
```

Observed successful runtime state:

- app reachable on `0.0.0.0:3010`
- standalone Feishu runtime connected and reported `status: "running"`
- Feishu commands returned visible bot replies

## Operational Notes

Current expected local startup:

```bash
npm run dev
```

```bash
npm run feishu:runtime
```

Important:

- `.env` contains local runtime settings and secrets and was not committed as part of this change
- `prisma/dev.db` and `prisma/dev.db-journal` are local environment state and were not committed

## Files Changed

- `package.json`
- `scripts/feishu-standalone-monitor.js`
- `src/app/api/feishu/connection/route.ts`
- `src/instrumentation.ts`
- `src/lib/feishu-long-connection.ts`
- `src/lib/feishu-runtime-status.ts`
- `.gitignore`

## Remaining Follow-up

Feishu long-connection hosting is now fixed.

Any remaining Feishu issues should be treated separately from runtime hosting, for example:

- `/ap room`
- live room binding behavior
- higher-volume command reliability
