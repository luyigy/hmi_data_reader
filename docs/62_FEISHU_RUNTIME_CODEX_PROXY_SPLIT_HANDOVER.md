# 62 Feishu Runtime Codex Proxy Split Handover

## Date
2026-04-05

## Problem

After Feishu standalone runtime recovery, `/ap` commands worked again, but plain live-room messages routed to local Codex still failed with errors like:

```text
系统提示：codex 本次回复失败：stream disconnected before completion:
error sending request for url (https://chatgpt.com/backend-api/codex/responses)
```

Observed runtime evidence:

- Feishu standalone runtime needed proxy bypass to keep websocket long-connection stable
- Codex child process then inherited the same proxy-stripped environment
- Feishu-triggered Codex turns attempted direct access to `chatgpt.com`
- result: websocket / responses stream failures

## Root Cause

The runtime boundary had two conflicting networking requirements:

1. Feishu long-connection process should not use the local `127.0.0.1:1081` proxy
2. Codex child processes spawned from that runtime still need proxy to reach OpenAI / ChatGPT endpoints

Before this fix, `src/lib/real-agents/codex-agent.ts` spawned Codex with:

```ts
env: { ...process.env }
```

So when `feishu:runtime` was started with proxy variables removed, Codex inherited that proxy-less environment and failed outbound requests.

## Fix

### 1. Split Feishu runtime network env from Codex child env

Updated:

- `package.json`

`npm run feishu:runtime` now:

- copies current shell proxy values into dedicated vars:
  - `FEISHU_RUNTIME_CODEX_HTTP_PROXY`
  - `FEISHU_RUNTIME_CODEX_HTTPS_PROXY`
  - `FEISHU_RUNTIME_CODEX_ALL_PROXY`
  - `FEISHU_RUNTIME_CODEX_NO_PROXY`
- then unsets standard proxy vars only for the Feishu standalone runtime process

This keeps the Feishu websocket direct while preserving proxy info for downstream Codex execution.

### 2. Restore proxy only for Codex child processes

Updated:

- `src/lib/real-agents/codex-agent.ts`

Codex spawn now rebuilds child env using the preserved `FEISHU_RUNTIME_CODEX_*` values, restoring:

- `http_proxy` / `HTTP_PROXY`
- `https_proxy` / `HTTPS_PROXY`
- `all_proxy` / `ALL_PROXY`
- `no_proxy` / `NO_PROXY`

This affects Codex child execution only and does not change the Feishu websocket process itself.

### 3. Documented fallback env vars

Updated:

- `.env.example`

Added optional dedicated variables so the proxy split can also be configured explicitly from env, not only inherited from the launching shell.

## Files Changed

- `package.json`
- `src/lib/real-agents/codex-agent.ts`
- `.env.example`

## Verification

Verified on the live server session:

- environment still had:
  - `http_proxy=http://127.0.0.1:1081`
  - `https_proxy=http://127.0.0.1:1081`
  - `all_proxy=http://127.0.0.1:1081`
- Feishu standalone runtime restarted successfully
- runtime reached:

```text
[ws] ws client ready
```

This restored the intended split:

- Feishu long-connection bypasses proxy
- Feishu-triggered Codex requests can use proxy again

## Operational Note

If the runtime is started from a shell without proxy variables, set these explicitly:

- `FEISHU_RUNTIME_CODEX_HTTP_PROXY`
- `FEISHU_RUNTIME_CODEX_HTTPS_PROXY`
- `FEISHU_RUNTIME_CODEX_ALL_PROXY`
- `FEISHU_RUNTIME_CODEX_NO_PROXY`

Otherwise Codex child requests will again run without proxy.

