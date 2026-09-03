# 修复与中断恢复记录：飞书直接切换 Session 误生成 Handover 与服务重启恢复（2026-09-03）

## 背景与现象

在飞书任务室执行 Session 换代操作时（例如触发 `/ap new-session` 或点击换代卡片）：
1. 当项目检测到存在未完成 PLAN 且未提供已提交 Handover 时，平台会推送确认卡片供用户决策：
   - 「生成并提交 Handover 后切换」
   - 「直接切换」
   - 「取消」
2. 用户明确点击「直接切换」（或执行带 `--direct` 参数的换代命令）时，预期行为是：仅重置参与 Agent 的会话上下文，**绝不生成任何 Handover 交接文档或提交**。
3. 实际现象：
   - 点击「直接切换」后，卡片进度回复误提示：`⏳ 已接收，正在后台处理 Session 切换与 Handover 生成...`。
   - 目标仓库工作区被触发了应急换代检查点生成逻辑，在目标仓库（如 `mold-data-webpage-tool`）根目录生成大量 `NNN_HANDOVER_YYYYMMDD_Session换代_*.md` 检查点文档并产生 Git 提交，对用户工作流造成干扰。
4. 修复实施过程中的偶发事件：
   - 2026-09-03 11:12:03 CST，`agent-platform-feishu.service` 收到 SIGTERM 并由 systemd 重启。
   - 平台根据生命周期机制清理了 1 个处于 running 状态的 delivery，导致正在执行修复的 antigravity 任务被停止，任务室收到中断提示。
   - 用户使用恢复命令接续任务后，定位到未提交的 3 个文件并安全保护，随后完成了问题验证与修复提交。

## 根因分析

1. **卡片动作处理层（`feishu-long-connection.ts`）文案与状态传递未区分：**
   - 卡片交互回调中的 `onStarted` 提示文案硬编码为“正在后台处理 Session 切换与 Handover 生成...”，即使用户点击「直接切换」也会发送此误导性提示。
2. **确认卡派发选项未清理 Handover 传参（`feishu-new-session.ts`）：**
   - `handleNewSessionConfirmationCardAction` 在用户选择 `decision === 'direct'` 时，透传了原始命令选项，未显式清理旧卡片可能附带的 `generate-handover`、`handover`、`from-handover` 等参数。
3. **换代核心入口缺少 direct 强制守卫（`feishu-new-session.ts`）：**
   - `handleNewSessionCommand` 未对 `direct` 进行强隔离：只要 `command.options['generate-handover'] === 'true'` 成立，即使传入了 `direct`，依然会执行 `generateCommittedHandover` 应急生成检查点并提交；同时 `handoverOption` 也未强制清空。

## 修复内容（commit a1c002a）

- **卡片处理与进度提示解耦（`src/lib/feishu-long-connection.ts`）：**
  - `buildCardActionHandler` 中 `onStarted` 接口接收 `decision: 'handover' | 'direct'`。
  - 当 `decision === 'direct'` 时，提示文案变更为：`⏳ 已接收，正在后台处理 Session 切换...`；仅当 `decision === 'handover'` 时才提示包含 Handover 生成。
- **换代命令强隔离 direct 模式（`src/lib/feishu-new-session.ts`）：**
  - 判定 `direct = isTruthyFeishuOption(command.options['direct'])`。
  - 在 `direct` 为 true 时，强制将 `handoverOption` 置为空字符串 `''`。
  - 在 `confirmed` 判定中加入 `direct`，且在执行生成检查点的条件上增加 `!direct` 守卫（`if (confirmed && !direct && command.options['generate-handover'] === 'true')`），彻底阻断 direct 模式下的 Handover 生产。
  - 在 `handleNewSessionConfirmationCardAction` 中，当 `decision === 'direct'` 时，显式 `delete nextOptions['generate-handover']`、`delete nextOptions['handover']`、`delete nextOptions['from-handover']`，确保进入执行层的参数完全不含 Handover 意图。
- **定向自动化回归测试（`tests/new-session-rotation.test.ts`）：**
  - 增加卡片直接切换异步流程测试，验证 toast 提示为 `已开始切换 Session...`。
  - 增加对目标 Git 仓库 HEAD 的断言检查：断言执行直接切换后 Git HEAD 保持不变，验证绝对不会生成、暂存或提交任何换代文档。
  - 增加通过命令行 `--direct` 触发直接切换的回归测试，同样断言 HEAD 不变且不生成任何文档。

## 中断处理与恢复

1. 11:12:03 Feishu Runtime 重启后，未提交的代码（`feishu-long-connection.ts`、`feishu-new-session.ts`、`tests/new-session-rotation.test.ts`）保留在工作区。
2. 恢复命令接管后，首先执行了 Git 状态保护与长文件守卫检查，确认代码完整无损。
3. 随后对实现细节进行了加固审阅，将原地修改传入参数收紧为构建新的纯净选项对象，避免潜在副作用。
4. 跑通所有回归测试后，将改动正式提交：`a1c002a fix(feishu): keep direct session rotation handover-free`。

## 验证

- `npm run test:new-session-rotation`：全部测试通过，包含本次新增的 direct 异步与同步切换用例。
- `npm run check:long-files`：长文件守卫通过，无超过 1000 行文件。
- `npx tsc --noEmit`：TypeScript 类型检查通过。
- 运行中服务状态：`agent-platform-feishu.service` 正常 active 运行。

## 运维与使用备注

- 用户在飞书卡片中点击「直接切换」或命令中使用 `/ap new-session --direct`，将纯净重置会话，不会产生任何文档残留。
- 若确实需要换代交接文档，请明确点击「生成并提交 Handover 后切换」或在命令中指定 `--generate-handover=true`。
