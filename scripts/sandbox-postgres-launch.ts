/**
 * S02 手动修复：沙箱命令渲染驱动。
 *
 * 读取宿主入口写出的 launch-config.json，用仓库自身的沙箱机制
 * （prepareSandboxEnvironment + renderBubblewrap，与生产任务完全相同的渲染路径）
 * 编译出 bwrap 命令并输出 JSON。本文件不新增环境白名单、不绕过任何过滤。
 *
 * 与生产 runSandboxedGraphCheck 一致：linked worktree 的 index/refs/objects
 * 位于检出目录之外，需按 linkedWorktreeGitDirectories 以只读方式挂入沙箱，
 * 否则沙箱内 git（如 executionConditionsVersion 的 rev-parse）无法工作。
 */
import { readFileSync } from 'node:fs';
import { prepareSandboxEnvironment, type SandboxEnvironmentInput } from '../src/lib/sandbox-manager/environment';
import { renderBubblewrap } from '../src/lib/sandbox-manager/bubblewrap';
import { linkedWorktreeGitDirectories } from '../src/lib/real-agents/git-worktree-paths';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8')) as SandboxEnvironmentInput;
const readOnlyPaths = Array.from(new Set([...(input.readOnlyPaths || []), ...linkedWorktreeGitDirectories(input.workspaceRoot)]));
const plan = prepareSandboxEnvironment({ ...input, readOnlyPaths });
const rendered = renderBubblewrap(plan);
process.stdout.write(JSON.stringify(rendered));
