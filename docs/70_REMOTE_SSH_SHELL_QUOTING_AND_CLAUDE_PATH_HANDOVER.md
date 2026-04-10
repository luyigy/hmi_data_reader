# 70 Remote SSH Shell Quoting And Claude Path Handover

## Summary

Fixed intermittent `TX-server Claude` failures where the platform surfaced:

```text
bash: line 1: claude: command not found
```

and previously sometimes masked that with:

```text
bash: line 1: powershell.exe: command not found
```

The root cause was not a missing Claude install on TX. The real bug was our SSH remote command construction.

## Root Cause

In `src/lib/remote-harness/ssh-executor.ts`, we were passing the remote command to `ssh` in the wrong shape.

Bad effective behavior:

```text
ssh <host> bash -lc <command>
```

Required behavior:

```text
ssh <host> "bash -lc '<command>'"
```

Because of that difference, the remote TX shell did not get the expected login-shell PATH setup, so `claude` was not resolvable even though it existed on disk.

## What We Verified On TX

Connected directly as the configured remote user:

- host: `10.0.8.10`
- user: `ww`
- working directory: `/data/deploy`

Important findings:

- `claude` exists at `/home/ww/.local/bin/claude`
- when remote command is sent correctly as one quoted string:
  - `PWD=/data/deploy`
  - `PATH=/home/ww/.local/bin:...`
  - `command -v claude => /home/ww/.local/bin/claude`
- when command is sent in the old broken multi-arg form:
  - `PWD=/home/ww`
  - `PATH` does not include `/home/ww/.local/bin`
  - `command -v claude => missing`

## Changes Made

### 1. Fix SSH remote command construction

Updated `src/lib/remote-harness/ssh-executor.ts` so remote commands are sent as a single quoted string again:

- unix path now returns `bash -lc '<command>'`
- powershell path now returns a single `powershell.exe ... -EncodedCommand ...` string
- `runRemoteSshCommand()` now always appends a single remote command string to `ssh`

### 2. Prevent bogus Windows fallback on normal Linux errors

Narrowed `shouldRetryWithPowerShell()` so generic Linux errors like:

- `bash: line 1: claude: command not found`
- `bash: line 1: powershell.exe: command not found`

do **not** trigger a Windows retry.

### 3. Add remote preflight diagnostics

Added stderr preflight lines before remote harness execution:

- `__ACPX_PREFLIGHT_PWD__=...`
- `__ACPX_PREFLIGHT_PATH__=...`
- `__ACPX_PREFLIGHT_WHICH__=...`

These are useful for future debugging of remote shell environment issues.

### 4. Add local server-side debug logs

Added structured log lines such as:

- `[Remote SSH] Starting ... via unix shell`
- `[Remote SSH] Unix shell failed ... retryWithPowerShell=...`
- `[Remote SSH Probe] ...`

## User-Visible Result

After restart, `TX-server Claude` resumed working correctly.

## Key Lesson

For remote shell execution over SSH, argument shape matters. Passing command fragments as multiple local args is **not** equivalent to sending one correctly quoted remote shell command string.

## Files Changed

- `src/lib/remote-harness/ssh-executor.ts`
- `docs/70_REMOTE_SSH_SHELL_QUOTING_AND_CLAUDE_PATH_HANDOVER.md`
- `docs/IMPORTANT_DISCOVERIES.md`
