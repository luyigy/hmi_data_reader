# Agent Platform v2

Agent Platform v2 is a Next.js-based control surface for running and coordinating local, remote, and chat-integrated AI agents. It includes ACPX task execution, live rooms, Feishu/Lark messaging integration, remote SSH harness support, and workspace-oriented task views.

## Features

- ACPX task runner for local and remote agent execution.
- Live rooms with user, system, and assistant messages.
- Feishu/Lark long-connection and webhook integration.
- Platform-local harnesses for tools such as Codex, Claude, Antigravity CLI, Gemini CLI, DeepSeek, and pi-agent.
- Remote SSH harness hosts for running agents on other machines.
- Per-member live-room context watermarking and permission display.
- Basic gateway registration and control-plane APIs.

## Tech Stack

- Next.js 14
- React 18
- Prisma 5
- SQLite for local development
- Socket.IO for task and live-room updates
- Feishu/Lark OpenAPI SDK
- Playwright for browser tests

## Requirements

- Node.js 20+
- npm
- A local SQLite-compatible environment
- Optional: Feishu/Lark app credentials
- Optional: installed agent CLIs such as `codex` or `claude`

## Setup

```bash
npm ci
cp .env.example .env
npx prisma migrate dev
npm run dev
```

The development server defaults to:

- Web app: `http://localhost:3010`
- Socket.IO: `3101`

## Environment

Start from `.env.example`. Do not commit `.env` or other local env files.

Important variables:

- `DATABASE_URL`: local database URL, usually `file:./dev.db`.
- `SOCKET_PORT` and `NEXT_PUBLIC_SOCKET_PORT`: Socket.IO port configuration.
- `FEISHU_CONNECTION_MODE`: `long_connection` or `webhook`.
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN`, `FEISHU_ENCRYPT_KEY`: Feishu/Lark app credentials.
- `ACPX_CODEX_SANDBOX_MODE`: Codex sandbox setting for local harness execution.
- `ANTIGRAVITY_CLI_PATH`: optional path to the Antigravity `agy` executable.
- `LINUX_GATEWAY_*`: optional smoke-test target for remote gateway checks.

## Scripts

```bash
npm run dev             # Start Next.js development server
npm run build           # Build production bundle
npm start               # Start production server
npm run lint            # Run Next.js lint
npm run feishu:runtime  # Start Feishu long-connection runtime
```

## Repository Hygiene

Generated artifacts and local secrets should stay out of git:

- `.env` and `.env.*`
- `prisma/dev.db`
- `.next/`
- `.codegraph/`
- `playwright-report/`
- `test-results/`

If credentials were ever committed, rotate them before publishing and clean git history before pushing to a public remote.

## Development Notes

- Prefer focused modules over very large source files. Treat 1000 lines as a soft upper bound.
- Keep Feishu/Lark credentials, gateway tokens, SSH keys, and provider API keys out of the repository.
- Use `.env.example` for documented configuration and local `.env` for real values.
- Run lint/build before opening a PR when possible.

## License

No open-source license has been selected yet. Choose and add a `LICENSE` file before publishing.
