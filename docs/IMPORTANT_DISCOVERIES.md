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

## 2026-08-15: Non-interactive SSH login shells (`bash -lc`) bypass `.bashrc` NVM PATH initialization for remote CLI agents

Context:

- remote host: remote Linux host (e.g. Raspberry Pi / Ubuntu nodes)
- harness: `pi-agent` (or any CLI agent installed under NVM / user node paths like `codex`, `claude`)
- file: `src/lib/remote-harness/ssh-executor.ts`

Discovery:

- When running non-interactive SSH commands with `bash -lc '<cmd>'`, Debian/Ubuntu `.bashrc` terminates immediately at the top due to the non-interactive guard:
  ```bash
  case $- in
      *i*) ;;
        *) return;;
  esac
  ```
- NVM’s initialization code (appended to the bottom of `~/.bashrc`) is never reached.
- Bash as a login shell searches for `~/.bash_profile`, `~/.bash_login`, and `~/.profile` in order and stops at the first match. If `$PATH` modifications are solely in `~/.bashrc`, binaries in `$HOME/.nvm/versions/node/<ver>/bin` (such as `pi`) are omitted from `$PATH`, causing `command not found` or `NOT FOUND`.

Why this matters:

- Interactive SSH login (`ssh user@host`) works fine because the shell is interactive (`$-` contains `i`), loading `~/.bashrc` and NVM properly.
- Automated execution via `bash -lc` fails mysteriously with `command not found` despite the binary existing on the remote machine.

How to fix:

1. Create or update `~/.bash_profile` on the remote host:
   ```bash
   # ~/.bash_profile
   export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"

   if [ -f "$HOME/.profile" ]; then
       . "$HOME/.profile"
   fi
   ```
2. Simulate and verify non-interactive login shell execution:
   ```bash
   env -i HOME=$HOME USER=$USER TERM=xterm-256color bash -lc 'echo PATH=$PATH; command -v pi'
   ```

Related lesson doc:

- `docs/440_LESSON_20260815_Remote_SSH_NonInteractive_Login_Shell_NVM_PATH.md`
