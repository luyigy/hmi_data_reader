---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: docs/312_PLAN_20260729_KimiCodeCLI接入PlatformLocal.md
slice: S03
plan_progress: complete
---

# HANDOVER · Kimi Code Prompt 权限冲突修复

## 问题与根因

Platform Local 调用 Kimi Code 0.29.2 时同时传入 `--prompt` 和显式权限参数：
`full_access` 使用 `--yolo`，其他 profile 使用 `--auto`。Kimi CLI 禁止将
`--prompt` 与这两个参数组合，任务会在 CLI 参数解析阶段直接失败。

`--prompt` 非交互模式本身会隐式启用最高级别的 `auto` 权限，因此显式权限参数既重复又冲突。
Platform 的安全边界实际由外层 Bubblewrap 决定：

- `full_access`：不包 Bubblewrap，Kimi 使用 `--prompt` 隐式 `auto`。
- `safe_local`：包 Bubblewrap，Kimi 仍使用 `--prompt` 隐式 `auto`，但只能访问沙盒允许的范围。

## 处理方式

- 从 `runKimiCodeCommand` 的参数中删除 `--yolo` / `--auto`，保留
  `--prompt --output-format stream-json`。
- 在参数构造处补充注释，固定“prompt 隐式 auto、Bubblewrap 负责隔离”的关键契约。
- 扩展 fake CLI 回归：检测 `--prompt` 与 `--yolo` / `--auto` 同时出现时立即失败，
  防止冲突参数回归。
- 保留原有权限回归：`safe_local` 阻止工作区外写入，`full_access` 允许工作区外写入。

## 验证结果

- 真实 Kimi CLI 0.29.2 仅使用 `--prompt --output-format stream-json` 时自动批准 Bash，
  并成功写入工作目录之外的临时测试文件，确认隐式 `auto` 权限有效。
- `tests/kimi-code-agent.test.ts` 通过，覆盖参数冲突、首轮与续聊、无效 Session fallback、
  stop、timeout、结构化错误、非零退出和 Bubblewrap 权限边界。
- `npx tsc --noEmit`、`npm run check:long-files`、`git diff --check` 通过。
- GitNexus upstream impact 为 LOW：1 个直接调用者，影响 2 条执行流程。
- Feishu runtime 正常运行；功能参数删除早于本轮 runtime 启动，之后只补充了不影响行为的注释。

## 遇到的坑

1. 删除冲突参数不等于完成权限验证。必须额外确认 `--prompt` 的隐式权限，否则容易把
   “CLI 能启动”误判为“仍具备 full access”。
2. `--yolo` 不是最高权限；`auto` 的无人值守范围更完整。不能根据参数名称猜权限等级。
3. `--prompt` 不能简单替换为 stdin：当前 `stream-json` 适配依赖 prompt 非交互模式；
   改 stdin 实际上需要重做 ACP 客户端，超出本次根因修复。
4. Kimi 内部权限和 Platform 文件隔离是两层机制。`safe_local` 不能靠降低 Kimi 权限实现，
   必须保留 Bubblewrap；`full_access` 则必须明确跳过 Bubblewrap。
5. 仅用 fake CLI 能证明参数不会冲突，不能证明真实 CLI 的隐式 `auto` 行为；最终需要真实工具
   写入验证补齐证据。

## 修改范围

- `src/lib/real-agents/kimi-code-agent.ts`
- `tests/kimi-code-agent.test.ts`
- `docs/316_HANDOVER_20260729_KimiCodePrompt权限冲突修复.md`

工作区内其他既有改动未修改，也不纳入本次提交。

<!-- WORKFLOW_PROMPT_START -->
Kimi Code CLI 接入 Platform Local 的 S03 及其 `--prompt` 权限冲突修复已经完成并验证，
无需启动后续 Session。只读参考
`docs/312_PLAN_20260729_KimiCodeCLI接入PlatformLocal.md` 和
`docs/316_HANDOVER_20260729_KimiCodePrompt权限冲突修复.md`；除非用户提出新需求，
不要修改代码、文档、服务或生产数据。
<!-- WORKFLOW_PROMPT_END -->
