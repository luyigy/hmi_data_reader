---
doc_type: ISSUE
doc_status: draft
next_action: none
---

# ISSUE · Workflow 编排失败恢复收据与断点继续（/plan、/run）

## 优先级与状态

- 优先级：P1（建议列为第一梯队首位）。触发于 2026-08-04 真实事故，且其 P0 子步骤（错误分类）改动极小、收益极高。
- 状态：draft，记录于 Git Inbox，等待排期实施。
- 提出时间：2026-08-04。
- 关联议题：376（Handoff/PLAN 提交链状态反馈）、348（Watchdog 误判长任务）、377（执行过程折叠显示）。三者共同构成“失败可观测性与恢复”主题簇，建议合并排期。

## 问题背景

### 1. 触发事故

Live Room `/plan` 编排中，成员 `antigravity` 在“成员建议”阶段以 `workspace-write` 权限进入 Bubblewrap + Antigravity `--sandbox` 受限路径后，启动约 0.7 秒即以非零状态退出，唯一 stderr 为一行 tcmalloc 警告。平台据此将该成员记为 `failed`，编排器按设计停止，**尚未进入主持人的“PLAN 修订/提交”阶段**。

但平台对用户呈现的唯一提示是笼统的：

> 系统提示：PLAN 未提交：…

这条提示会误导用户去查 PLAN 文件内容或 Git 提交记录，而真正原因既不是 PLAN 写坏，也不是 Git 提交失败。

### 2. 根因：提示归一化 + 缺少断点恢复

当前 `/plan`、`/run` 的异常处理在 `src/lib/live-room-workflows.ts` 末尾用单一 `catch` 把**所有阶段**的异常统一包装成“PLAN 未提交”：

```ts
// src/lib/live-room-workflows.ts:200
} catch (error) {
  await postLiveRoomMessage({ roomId, content: `系统提示：PLAN 未提交：${error instanceof Error ? error.message : String(error)}`, messageType: 'system' });
}
```

其上游可能抛出的失败至少有四类，语义完全不同，却被合并成同一句：

| 失败类型 | 实际含义 | 是否产生文件/提交 |
|---|---|---|
| 成员执行失败 | 某成员进程崩溃/超时（本次事故） | 否 |
| PLAN_PATH 不合法 | 主持人未返回合法路径或与 revision 不符 | 否 |
| Git 提交失败 | 写入后 commit/push 阶段异常 | 可能部分 |
| validator 失败 | PLAN 已提交但校验不通过 | 是（需修订） |

### 3. 现状：三套彼此割裂的恢复能力

- 普通成员回复已有“失效 continuation 自动换新会话重试”，见 `src/lib/live-room-delivery-execution.ts:518` 附近。
- 服务重启会给普通 Live Room delivery 生成恢复命令，见 `src/lib/feishu-long-connection.ts:122`（`buildFeishuRuntimeRecoveryCommand`）。
- `/plan`、`/run` 自己串行执行各阶段，阶段结果只存在聊天消息和局部内存里；任何异常最终都显示“PLAN 未提交”，**无可恢复的聚合运行记录**。

因此“修好执行环境后原样重试”既不方便（用户要重新拼 `PLAN_REVISE` / `/plan` 内容），也会重复跑已完成阶段。

## 处理思路与优化方案

目标体验：平台提供“失败收据 + 一键从失败阶段继续”，而不是让用户理解 `PLAN_REVISE`、重新拼命令或整轮重跑。

### 0. 失败收据卡（用户可见面）

失败时直接发一张恢复卡，而非一句“PLAN 未提交”：

```text
⚠️ PLAN 编排已暂停

失败阶段：成员建议（antigravity）
失败类型：Agent 启动失败
影响：PLAN 定稿尚未开始，没有文件或提交需要回滚
已保留：前序讨论结果
恢复方式：平台修复执行环境后，可从当前阶段继续

[从当前阶段继续]  [重新开始整轮]  [查看诊断]
```

- 点击“从当前阶段继续”：用新进程重新执行失败成员，注入原任务和已成功阶段的输出；成功后继续剩余成员与主持人定稿；最后仍走原有 PLAN 提交和 validator；用户无需重发 `PLAN_REVISE`。
- 保留一条可复制的恢复命令作为卡片不可用时的兜底，但不应让命令成为主要入口。

### 1. P0：先把提示改正确（最小改动、立即可做）

- 区分“成员执行失败 / PLAN_PATH 不合法 / Git 提交失败 / validator 失败”四类，分别给出对应文案与处置引导。
- 展示失败成员、阶段、实际退出状态、是否产生文件或提交。
- tcmalloc 这类原生进程 stderr 放进“诊断详情”，不作为主错误标题。
- 若暂时没有断点恢复，至少提供“重新执行原始 PLAN 请求”，不让用户重新拼内容。

### 2. P1：实现真正的断点恢复（轻量 Workflow Run checkpoint）

为 `/plan`、`/run` 保存一个极小的 Workflow Run checkpoint，至少包含：

- 原始消息和任务；
- 固定的主持人、成员顺序及权限快照；
- 当前阶段和已完成阶段；
- 每阶段输出及对应 `taskRunId`；
- 失败分类、错误指纹和重试次数；
- 开始时的仓库 HEAD；
- `running / paused / completed` 状态。

约束：

- 恢复必须使用原 checkpoint，而不是从聊天正文猜状态。
- 按钮操作采用原子 `paused → running` 更新和幂等键，避免重复点击启动两轮。
- 现有 `WorkflowDispatch` 是 watcher 专用结构（字段和身份都不适合硬塞 Live Room 编排），**建议独立一个很小的 Workflow Run 记录**，不建设通用“恢复中心”。

### 3. P2：有限自动恢复

平台只自动重试一次明显的瞬态错误，例如：

- continuation 失效；
- 网络连接中断；
- 已知临时状态库错误；
- 服务重启造成的进程终止。

像本次沙箱启动失败这种**确定性环境错误**，应立即暂停。相同错误指纹连续出现时不再循环重试，等待平台修复后由用户点击继续。

## 验收目标

1. 任意阶段失败时，用户收到的提示明确区分失败类型、失败成员/阶段、退出状态、是否产生文件或提交；不再统一显示“PLAN 未提交”。
2. tcmalloc 等无害 stderr 仅出现在“诊断详情”，不作为主错误标题。
3. 修复执行环境后，用户可通过“从当前阶段继续”一键恢复：前序阶段不重跑，失败成员用新进程执行，成功后自动继续到 PLAN 提交与 validator。
4. 相同错误指纹连续出现时不循环自动重试；瞬态错误最多自动重试一次。
