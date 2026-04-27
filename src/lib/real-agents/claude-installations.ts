/**
 * Claude Installation Registry
 *
 * Defines all known Claude CLI installations on this machine.
 * Each installation has its own binary, config directory, and environment.
 */

export interface ClaudeInstallation {
  /** Display name */
  name: string;
  /** Absolute path to the CLI binary/script */
  binaryPath: string;
  /** HOME directory for the subprocess (affects ~ expansion, bun binaries, etc.) */
  homeDir: string;
  /** Explicit CLAUDE_CONFIG_DIR value (or undefined to use default) */
  configDir?: string;
  /** Additional env vars to inject */
  env?: Record<string, string>;
}

export const CLAUDE_INSTALLATIONS: Record<string, ClaudeInstallation> = {
  /** Default system-wide Claude install */
  'claude': {
    name: 'Claude',
    binaryPath: '/home/hello/.local/bin/claude',
    homeDir: process.env.HOME || '/home/hello',
    configDir: undefined, // uses system default ~/.claude
    env: {},
  },

  /** Claude-haha custom install (separate config in ~/.claude-haha) */
  'claude-haha': {
    name: 'Claude-Haha',
    // bash wrapper script that calls: bun --env-file=.env ./src/entrypoints/cli.tsx
    binaryPath: '/data1/code/cc-haha-oc/bin/claude-haha',
    homeDir: '/home/hello',
    configDir: '/home/hello/.claude-haha',
    env: {
      'CLAUDE_CONFIG_DIR': '/home/hello/.claude-haha',
    },
  },
};

/**
 * Resolve installation config by harness type key.
 * Defaults to "claude" if key not found.
 */
export function resolveClaudeInstallation(
  harnessType: string
): ClaudeInstallation {
  return CLAUDE_INSTALLATIONS[harnessType] ?? CLAUDE_INSTALLATIONS['claude'];
}

/**
 * Returns true if harnessType is any Claude-based harness (claude or claude-haha).
 */
export function isClaudeHarnessType(harnessType: string): boolean {
  return harnessType === 'claude' || harnessType === 'claude-haha';
}
