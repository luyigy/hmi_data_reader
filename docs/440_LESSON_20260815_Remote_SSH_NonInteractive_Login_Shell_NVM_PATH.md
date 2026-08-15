# 440 Lesson: Remote SSH Non-Interactive Login Shell & NVM PATH Resolution for CLI Agents

## Summary

When onboarding or connecting remote Linux nodes (e.g., Raspberry Pi, Debian/Ubuntu servers) to Agent Platform, remote CLI agent harnesses (`pi`, `codex`, `claude`, `kimi-code`, etc.) installed via **Node Version Manager (NVM)** or user-scoped node managers often fail during automated execution with `command not found` or `NOT FOUND`, even though logging into the node interactively via SSH succeeds without issues.

This document records the deep root cause, diagnostic reproduction commands, permanent fixes, and standard onboarding checklist.

---

## Context & Incident Description

- **Remote Host**: Remote Linux host (e.g., Raspberry Pi / Ubuntu running node `v24.19.0` under `/home/shaw/.nvm/...`).
- **Target Harness**: `pi-agent` (binary location: `/home/shaw/.nvm/versions/node/v24.19.0/bin/pi`).
- **Platform Execution Method**: Non-interactive SSH login shell via `ssh host "bash -lc '<command>'"` in [`ssh-executor.ts`](file:///data1/code/agent-platform-v2/src/lib/remote-harness/ssh-executor.ts).

### Observed Discrepancy

| Invocation Mode | Command | Result |
| :--- | :--- | :--- |
| **Interactive SSH** (Manual login) | `ssh shaw@remote-pi` then `command -v pi` | ✅ `/home/shaw/.nvm/versions/node/v24.19.0/bin/pi` (Found) |
| **Non-Interactive Login Shell** (Platform automation) | `ssh shaw@remote-pi "bash -lc 'command -v pi'"` | ❌ `pi NOT FOUND` / `bash: line 1: pi: command not found` |

---

## Root Cause Analysis

### 1. The Non-Interactive Early Return Guard in `.bashrc`

Default `~/.bashrc` files on Debian/Ubuntu systems include a non-interactive shell guard at the very beginning:

```bash
# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac
```

When a shell is non-interactive (such as running a single command via SSH or script), `$-` does not contain the flag `i`. The `case` statement immediately executes `return`, aborting any further execution of `~/.bashrc`.

### 2. NVM Default Setup Placement

NVM installer appends its environment exports at the bottom of `~/.bashrc`:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion" # This loads nvm bash_completion
```

Because `~/.bashrc` exits early on non-interactive shells, **NVM initialization code is never reached**. As a result, the Node version's `bin` directory is never prepended to `$PATH`.

### 3. Bash Startup File Hierarchy for `bash -lc`

Agent Platform wraps commands in `bash -lc '<cmd>'`:
- `-l` (login shell): Bash reads `/etc/profile`, then searches for `~/.bash_profile`, `~/.bash_login`, and `~/.profile` (in that order, reading only the **first** one that exists and is readable).
- `-c` (command string): Tells bash to execute the string non-interactively.

If `~/.bash_profile` or `~/.profile` relies on `~/.bashrc` for `$PATH` modifications, non-interactive login shells end up with only the minimal system default `$PATH` (e.g. `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin`).

---

## Reproduction & Verification Commands

To accurately reproduce and debug the remote execution environment without opening an interactive TTY:

```bash
# Clean environment simulation of platform non-interactive SSH login shell:
env -i HOME=/home/shaw USER=shaw TERM=xterm-256color bash -lc 'echo PATH=$PATH; command -v pi'
```

### Output Before Fix:

```text
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
pi NOT FOUND
```

---

## Resolution

### Solution (Applied on Remote Node): Create/Update `~/.bash_profile`

Create `~/.bash_profile` in the user's home directory on the remote host to ensure nvm-installed binaries are in `$PATH` for all login shells, while preserving existing `~/.profile` behavior:

```bash
# ~/.bash_profile: executed by bash(1) for login shells.

# Ensure pi and other nvm-installed binaries are available in non-interactive
# SSH sessions (e.g. when the agent platform runs `bash -lc 'pi ...'`).
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"

# Preserve normal login-shell behavior from ~/.profile.
if [ -f "$HOME/.profile" ]; then
    . "$HOME/.profile"
fi
```

### Verification After Fix:

```bash
env -i HOME=/home/shaw USER=shaw TERM=xterm-256color bash -lc 'command -v pi; pi --version'
```

Output:

```text
/home/shaw/.nvm/versions/node/v24.19.0/bin/pi
0.84.2
```

---

## Alternative Approaches & Best Practices

| Approach | Implementation | Pros | Cons |
| :--- | :--- | :--- | :--- |
| **A. `~/.bash_profile` explicit PATH export** *(Recommended)* | Add `export PATH="$HOME/.nvm/versions/node/<ver>/bin:$PATH"` to `~/.bash_profile` | Zero startup overhead; 100% reliable in `bash -lc` | Must be updated if the default Node version changes |
| **B. Dynamic NVM init in `~/.bash_profile`** | Put `export NVM_DIR=...; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"` in `~/.bash_profile` | Dynamically resolves active/default Node version | Adds ~50-100ms shell startup latency per SSH command |
| **C. Symlink into `~/.local/bin` or `/usr/local/bin`** | `ln -s $(which pi) ~/.local/bin/pi` | Standard Linux convention; works across all shells (bash/zsh/sh) | Requires `~/.local/bin` to be in `$PATH` |

---

## Standard Onboarding Checklist for Remote Agent Nodes

When adding a new remote SSH host or installing a new CLI harness on a remote node:

1. **Verify non-interactive login shell PATH**:
   ```bash
   ssh user@remote-node "bash -lc 'echo PATH=\$PATH'"
   ```
2. **Verify target agent binary location**:
   ```bash
   ssh user@remote-node "bash -lc 'command -v pi || command -v codex || command -v claude'"
   ```
3. **Verify agent execution & version**:
   ```bash
   ssh user@remote-node "bash -lc 'pi --version'"
   ```
4. **Check platform preflight diagnostics**:
   In Agent Platform's [`ssh-executor.ts`](file:///data1/code/agent-platform-v2/src/lib/remote-harness/ssh-executor.ts), look for the stderr preflight log lines:
   - `__ACPX_PREFLIGHT_PWD__`
   - `__ACPX_PREFLIGHT_PATH__`
   - `__ACPX_PREFLIGHT_WHICH__`

---

## Related Documents

- [`docs/IMPORTANT_DISCOVERIES.md`](file:///data1/code/agent-platform-v2/docs/IMPORTANT_DISCOVERIES.md)
- [`docs/70_REMOTE_SSH_SHELL_QUOTING_AND_CLAUDE_PATH_HANDOVER.md`](file:///data1/code/agent-platform-v2/docs/70_REMOTE_SSH_SHELL_QUOTING_AND_CLAUDE_PATH_HANDOVER.md)
- [`docs/97_REMOTE_PI_AGENT_AND_INTRA_ROOM_PRIVATE_CHAT_HANDOVER.md`](file:///data1/code/agent-platform-v2/docs/97_REMOTE_PI_AGENT_AND_INTRA_ROOM_PRIVATE_CHAT_HANDOVER.md)
- [`docs/98_REMOTE_PI_AGENT_AND_FEISHU_TARGET_LOCK_HANDOVER.md`](file:///data1/code/agent-platform-v2/docs/98_REMOTE_PI_AGENT_AND_FEISHU_TARGET_LOCK_HANDOVER.md)
- [`src/lib/remote-harness/ssh-executor.ts`](file:///data1/code/agent-platform-v2/src/lib/remote-harness/ssh-executor.ts)
