---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/352_PLAN_20260801_Workflow模板校验与Inbox录入闭环.md
slice: S02
plan_progress: in_progress
---

# HANDOVER · Workflow 模板、校验修复与 Inbox 录入闭环 S02

## 完成内容

- 新增由现有 TypeScript Validator 与 CLI 确定性生成的自包含 CommonJS 运行产物；生成过程只打包当前静态
  CommonJS 依赖图，不建立第二套 Validator 规则。
- Git guard v3 将运行产物安装到目标 Git dir 的 `agent-platform/workflow-validator.cjs`，hook 只通过目标仓库
  `git rev-parse --git-path` 定位并用普通 `node` 执行，不再引用平台绝对路径、`ts-node` 或平台
  `node_modules`。
- 安装器按内容幂等升级运行产物，并兼容升级 managed v1/v2 hook；unmanaged hook 的拒绝覆盖边界保持不变。
- 文档错误仍以 `WORKFLOW_DOCUMENT_VALIDATION_FAILED` marker fail-closed；bundle 缺失、Node 启动失败或依赖损坏
  仍按 runtime failure fail-open。append-only 的 ref 删除和 non-fast-forward 阻断逻辑未放松。

## 验证

- `npm run test:git-history-guard`
- `npm run test:workflow-validator`
- `npm run test:workflow-watcher`
- `npm run test:scheduled-jobs`
- `npx tsc --noEmit --pretty false`
- `npx eslint src/lib/scheduled-jobs/git-history-guard.ts scripts/build-workflow-validator.mjs tests/git-history-guard.test.ts`
- `npm run check:long-files`
- `git diff --check`

隔离仓库回归覆盖 managed v1/v2 升级、非 workflow commit、合法/非法 workflow 文档、bundle 缺失 fail-open、
ref 删除和 non-fast-forward。安装后的 bundle 位于 `/tmp` 仓库 Git dir，既不包含平台工作目录，也不保留
`require('yaml')`；合法文档没有 runtime warning，非法文档明确被拒绝。连续构建 SHA-256 一致。

## 边界与工作区

- 未扩大 Bubblewrap 挂载，未修改 HMI Reader，未执行外部仓库真实验收或其他外部动作。
- 未开始 S03 的 validation show/set/template/repair 控制面，也未开始 S04 Inbox 命令。
- 开工前已有的 7 个 workflow status/UI 工作区改动仍原样保留，不纳入本 Slice 提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/352_PLAN_20260801_Workflow模板校验与Inbox录入闭环.md` 的 S03：先读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml`、`docs/359_HANDOVER_20260801_Workflow模板校验与Inbox录入闭环S02交接.md`
与本 PLAN。保护所有开工前用户改动，只完成 S03：复用现有 `/ap workflow`、项目绑定、管理员/审批人权限、
40 位 HEAD 乐观锁、审计和 workflow status，实现 validation show、set balanced|strict、template 与幂等 repair；
模式只写目标仓库合同，修复优先恢复原 Session，同一 path + blob 不重复派单，不新增 repair queue，不开始 S04。
修改任一 function/class/method 前运行 GitNexus upstream impact，完成权限、过期 HEAD、dirty/conflict、重复回调、
服务重启与聚焦回归，运行 TypeScript、定向 ESLint、长文件检查、diff check 和 GitNexus detect_changes 后精确提交，
并创建 `plan_progress: in_progress`、`next_action: next_slice` 的 S03 HANDOVER；提交后停止。当前 Slice：S03。
<!-- WORKFLOW_PROMPT_END -->
