# Important Discoveries

This file is for durable, high-value discoveries that are easy to forget and expensive to rediscover.

## 2026-04-10: Remote SSH command quoting changes remote PATH behavior

Context:

- remote host: `TX-server`
- harness: `claude`
- file: `src/lib/remote-harness/ssh-executor.ts`

Discovery:

- `ssh host bash -lc <cmd>` is **not** equivalent to `ssh host "bash -lc '<cmd>'"`.
- The broken multi-arg form caused the TX remote shell to lose `/home/ww/.local/bin` from `PATH`.
- That made `command -v claude` return `missing` even though Claude existed at `/home/ww/.local/bin/claude`.

Why this matters:

- It can look like “Claude randomly disappeared” on Linux.
- It can produce intermittent failures when remote shell startup differs between invocation styles.
- It previously triggered a misleading Windows fallback and surfaced `powershell.exe: command not found`.

How to debug next time:

1. Check remote preflight stderr:
   `__ACPX_PREFLIGHT_PWD__`
   `__ACPX_PREFLIGHT_PATH__`
   `__ACPX_PREFLIGHT_WHICH__`
2. Compare direct SSH behavior vs wrapped `bash -lc` behavior.
3. Confirm whether the remote command is being sent as one shell string or fragmented into argv pieces.

Related handover:

- `docs/70_REMOTE_SSH_SHELL_QUOTING_AND_CLAUDE_PATH_HANDOVER.md`
