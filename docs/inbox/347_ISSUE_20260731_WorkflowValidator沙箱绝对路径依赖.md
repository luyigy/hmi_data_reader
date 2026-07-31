---
doc_type: ISSUE
doc_status: draft
next_action: none
---

# ISSUE · Workflow Validator 在执行沙箱中无法访问平台绝对路径

## 状态

- 优先级：P2，非紧急，等合适的平台维护窗口修复。
- 当前处理：仅记录，不启动 workflow，不修改 Agent Platform 或 HMI Reader 代码。
- 已知实例：HMI Reader 仓库提交 `4b2409e`。该提交已在宿主环境复验通过，不需要回滚或修改文档。

## 问题

Agent Platform 为目标仓库安装的 Git `reference-transaction` hook 会运行 workflow
validator。当 Kimi Code 等 Agent 在 `safe_local` Bubblewrap 沙箱内提交时，沙箱只挂载目标
仓库，但 hook 硬编码调用宿主机上的：

```text
/data1/code/agent-platform-v2/scripts/validate-workflow-documents.ts
/data1/code/agent-platform-v2/node_modules/ts-node/register/transpile-only
```

这些路径在宿主机存在，但在目标仓库的沙箱中不可见，因此 Node.js 报
`MODULE_NOT_FOUND`。hook 按现有 fail-open 策略将运行环境故障记为警告并允许提交。

## 影响

- 追加式 Git 历史保护仍然有效。
- 沙箱内的 PLAN/HANDOVER 文档校验会失效，无效文档可能在警告后被提交。
- 宿主环境和 watcher 后续仍可重新校验，因此当前不是数据丢失或服务中断故障。
- 问题不局限于 HMI Reader；任何使用同类沙箱且安装该 hook 的受监控仓库都可能命中。

## 建议的最小修复

1. 由 `git-history-guard.ts` 在安装 hook 时，将可由普通 Node.js 直接执行的 validator
   运行文件放到目标仓库 `.git/agent-platform/` 下。
2. hook 只调用目标仓库内的运行文件，不再依赖 Agent Platform 的绝对路径、
   `ts-node` 或平台 `node_modules`。
3. 保持现有语义：真实文档校验失败拒绝提交，validator 运行环境故障仍 fail-open
   并显示警告。
4. 不把整个 Agent Platform 目录挂载进沙箱，避免扩大可见范围并继续绑定安装路径。

## 验收标准

1. 在完全不可见 Agent Platform 安装目录的沙箱中，合法 workflow 文档可提交且无
   validator 运行警告。
2. 同一环境中，非法 workflow 文档会被 hook 拒绝。
3. 非 workflow 提交、非快进 ref 拦截、ref 删除拦截和 validator 运行故障的 fail-open
   回归测试保持通过。
4. watcher 或 scheduled-job runner 再次执行安装器后，已监控仓库的 hook 可幂等升级。
5. 在 HMI Reader 仓库完成一次合法文档和一次非法文档的沙箱验证。

## 工作量估算

结论：中小改动，不算大；预计 1 人 0.5–1 个工作日（约 4–8 小时）。

- 实现自包含 validator 的安装与 hook 调用：2–4 小时。
- 补充隔离环境、合法/非法文档和 fail-open 回归测试：2–3 小时。
- 部署、重装 hook 并在 HMI Reader 复验：约 1 小时。

主要不确定性是如何将 validator 与现有 `yaml` 运行依赖一起打包或安装到
`.git/agent-platform/`。不需要修改数据库 schema、Live Room 业务协议、HMI Reader 代码或
Bubblewrap 的整体权限模型。

## 建议实施时机

与下一次 workflow guard / watcher 维护一起处理，或在第二个受监控项目命中同类
`MODULE_NOT_FOUND` 时提前处理。若期间只出现警告，先在宿主环境手动复验对应
PLAN/HANDOVER，不修改目标项目依赖。
