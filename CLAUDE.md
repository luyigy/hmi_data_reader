# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # Dev server at localhost:3010 (runs prisma generate first)
npm run build         # Production build
npm start             # Production server
npm run lint          # ESLint
npm run feishu:runtime  # Start standalone Feishu WebSocket monitor
```

Database:
```bash
npx prisma migrate dev   # Apply migrations + regenerate client
npx prisma studio        # Browse DB at localhost:5555
npx prisma generate      # Regenerate client after schema changes
```

There are no automated tests. Manual testing is done via the Feishu bot or API calls.

## Architecture Overview

**Agent Platform v2** is a Next.js 14 app (port 3010) that orchestrates AI agent execution (Claude Code CLI, Codex CLI) across distributed gateways, with bidirectional Feishu enterprise IM integration.

### Request/Task Lifecycle

1. **Entry points**: Feishu bot message → `src/lib/feishu.ts` command parser, or REST API (`src/app/api/`)
2. **Task creation** → `Task` + `TaskRun` + `TaskSession` records in SQLite via Prisma
3. **Runner** (`src/lib/acpx/runner.ts`) picks an execution backend and spawns the harness
4. **Harness** executes the CLI tool (`claude` or `codex`), streams stdout/stderr as `TaskRunEvent` rows
5. **LiveRoom** fans out events to connected members; Feishu relay syncs messages back to the chat

### Key Subsystems

**ACPX Runtime** (`src/lib/acpx/`)
- `runner.ts` — dispatches TaskRuns to platform_local, gateway_openclaw, or remote_ssh backends
- `session.ts` — wraps one or more TaskRuns into a resumable TaskSession
- `interactions.ts` / `interaction-actions.ts` — permission/input/choice request handling (pending → approved/denied/answered)
- `session-tracking.ts` — monitors active sessions, watchdog timeouts (default 10 min)

**Real Agents** (`src/lib/real-agents/`)
- `claude-agent.ts` — spawns `claude` CLI, manages `--resume` continuation with session IDs
- `codex-agent.ts` — spawns `codex exec` CLI with sandbox mode env var (`ACPX_CODEX_SANDBOX_MODE`)

**Live Rooms** (`src/lib/live-room*.ts`)
- `live-room.ts` — room/member/message CRUD
- `live-room-delivery.ts` — per-member delivery tracking (pending → delivered/failed), intent detection (broadcast, mention, ask, handoff)
- `live-room-relay.ts` / `feishu-live-room.ts` — bidirectional sync between Feishu chat and LiveRoom

**Feishu Integration** (`src/lib/feishu*.ts`)
- `feishu.ts` — main command router (`/ap run`, `/ap room`, `/ap agents`, `/ap chat`, `/ap grant`, `/ap approve`, etc.)
- `feishu-api.ts` — token management, send/receive Feishu API calls
- `feishu-long-connection.ts` — WebSocket-based persistent event listener (alternative to webhook mode)
- `feishu-grant.ts` — permission delegation workflow
- Connection mode set via `FEISHU_CONNECTION_MODE=long_connection|webhook`

**Control Plane** (`src/lib/control-plane/`)
- `GatewayClient` → single gateway API wrapper (heartbeat, task dispatch, health check)
- `GatewayManager` → multi-gateway orchestration, load balancing (round-robin, least-loaded, latency-based), consecutive failure tracking
- Gateway health persisted in `ControlPlaneState` table

**WebSocket** (`src/lib/websocket.ts`) — Socket.IO server on port 3101; emits task stream events, live room updates, delivery status

### Data Model (SQLite / Prisma)

Core hierarchy: `Agent` → `Gateway` → `Task` → `TaskRun` → `TaskRunEvent`

- **TaskSession** — resumable wrapper around TaskRun(s); statuses: active, waiting_user, paused, completed, failed
- **TaskRunParticipant** — individual harness invocation with capability flags
- **LiveRoom / LiveRoomMember / LiveRoomMessage / LiveRoomDelivery** — collaborative space with per-member delivery tracking
- **FeishuConversationBinding** — maps Feishu `chat_id` ↔ `LiveRoom.id`
- **RemoteHarnessHost** — SSH-based remote execution config
- **ControlPlaneState** — gateway health metrics snapshot

Schema: `prisma/schema.prisma`. Migrations: `prisma/migrations/`.

### Environment Variables

Key vars (see `.env`):
```
DATABASE_URL=file:./dev.db
NEXT_PUBLIC_API_URL / AGENT_PLATFORM_BASE_URL   # self-reference for API calls
SOCKET_PORT=3101
ACPX_CODEX_SANDBOX_MODE=workspace-write         # workspace-write | read-only | danger-full-access
FEISHU_CONNECTION_MODE=long_connection
FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_VERIFICATION_TOKEN / FEISHU_ENCRYPT_KEY / FEISHU_BOT_OPEN_ID
```

### Utility Scripts (`scripts/`)

- `feishu-standalone-monitor.js` — background Feishu WebSocket listener (run separately)
- `register-remote-gateway.js` — register an SSH-based gateway
- `set-agent-nickname.ts` — update agent identity in DB
