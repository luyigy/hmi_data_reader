# Contributing

## Local Setup

```bash
npm ci
cp .env.example .env
npx prisma migrate dev
npm run dev
```

Run checks before submitting changes when practical:

```bash
npm run lint
npm run build
```

## Code Guidelines

- Keep changes focused and aligned with existing project patterns.
- Treat 1000 lines as a soft upper bound for a single source file.
- When extending an oversized file, prefer extracting cohesive helpers, hooks, services, route helpers, or components.
- Avoid committing generated artifacts, local databases, logs, screenshots, recordings, or local index files.
- Do not commit real credentials or private infrastructure details.

## Pull Requests

Include:

- what changed
- why it changed
- how it was tested
- known risks or follow-up work

For Feishu/Lark, remote SSH, or agent execution changes, include enough manual verification detail for a reviewer to reproduce the behavior without access to your private environment.
