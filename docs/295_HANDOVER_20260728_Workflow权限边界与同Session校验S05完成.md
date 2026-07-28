---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md
slice: S05
plan_progress: complete
---

# HANDOVER · Workflow 权限边界与同 Session 校验 S05 完成

## 验收结果

- 在临时 Git 项目中真实启动 `platform_local` Codex：云端对话成功，模型通过 `curl` 访问
  `https://example.com` 并只在项目内写入内容为 `NETWORK_OK` 的验收文件。
- Bubblewrap 隔离测试确认项目内可写；父目录、兄弟项目、路径穿越、符号链接逃逸、`/etc/passwd`、
  Docker socket 和宿主 `/tmp` 均不可见；沙箱 `/tmp` 独立，公开配置例外只读。
- 使用临时 `projects.yaml` 和内存审计 mock 验证 `/ap workflow policy show/set`：展示的
  `configured / effective / enforcement / exceptions` 与实际执行一致；管理员设置写回同一权威配置并
  生成审计，非管理员与非法 `preset=full` 均被拒绝。
- completion gate 隔离项目验证原 Session 继续修订、相同错误提前停止、最多两次纠正和原 Session
  不可用时只通知；watcher 验证 validator 失败不创建 repair Session，未通过文档不触发下一动作。
- permission card 验证 workspace 外操作直接拒绝且不发卡，旧 Session 的 pending interaction 变为
  `cancelled` 并 deny 原 waiter；普通卡不能授予 Full Access，其他 Harness 不显示虚假批准动作。

## 验收中修复

- `wrapWithBubblewrap` 现在会把公开只读目录内的一层符号链接真实目标一并只读挂载。此前
  `CODEX_HOME/auth.json` 的真实目标在沙箱中不可见，真实 Codex 因缺少认证返回 401。
- Codex 非交互启动与续跑现在把既有 `networkAccess` 快照映射为原生
  `sandbox_workspace_write.network_access=true/false`。此前外层 Bubblewrap 已共享网络，但 Codex
  内层 `workspace-write` 仍默认断网，导致 policy 显示 `network=enabled` 而模型内 `curl` 失败。
- 两项修复都复用现有策略和 Bubblewrap，没有新增权限预设、可写根、validator 或 watcher 行为。

## 验证

- `tests/project-config.test.ts`、`tests/workflow-execution-policy.test.ts`、
  `tests/bubblewrap.test.ts`、`tests/feishu-workflow-card.test.ts`、
  `tests/feishu-job-command.test.ts`：通过。
- `npm run test:workflow-validator`、`npm run test:workflow-completion-gate`、
  `npm run test:workflow-watcher`、`npm run test:feishu-permission-card`：通过。
- `src/lib/real-agents/codex-app-server.test.ts`、`npx tsc --noEmit` 和相关 ESLint：通过。
- `npm run check:long-files`、`git diff --check`：通过；6 个历史阻断长文件未增长，没有新增达到
  1000 行的文件。
- GitNexus pre-edit upstream impact：`wrapWithBubblewrap` 与 `buildExecArgs` 为 HIGH，
  `buildResumeArgs` 为 LOW；风险集中在 Codex/Claude 本机执行入口，已由 Bubblewrap、Codex 参数和真实
  隔离 Codex 验收覆盖。
- GitNexus staged-only `detect_changes` 为 HIGH：13 个 changed symbols、9 条受影响流程、4 个索引
  代码/测试文件；均位于预期的 Codex 参数构造、JSON 执行和 Bubblewrap 挂载链。

## 边界

- 未修改任何目标业务仓库、真实生产数据或服务状态，未重启服务。
- 开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 改动未修改、未纳入本次提交。
- 本 PLAN 已完成，`next_action: none`，不启动后续 Session。
