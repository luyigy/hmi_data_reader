---
doc_type: REPORT
doc_status: completed
next_action: none
---

# REPORT · 三 Harness 进度流验收

## 结论

S06 展示层实现与自动化回归通过；真实飞书卡片创建、更新和结束态验证通过。三种 harness 的直播室
真人回复均在 harness 启动前被既有项目路径配置阻断，因此“三 harness × 两条路径全部达标”未完成，
不能将 PLAN 417 标记为 complete。

## 实现与自动化证据

- `FeishuProgressTracker` 展示当前阶段（思考/工具/等待）、已用时、最近 5 条工具和累计步数；成功/
  失败结束态展示脱敏摘要、耗时、累计步骤和按工具聚合的 tally。
- 工具名、工具预览、系统事件、状态和结束摘要统一经过 S01 `sanitizePreview`。
- 卡片 1.5s、工具 3s、思考 8s、心跳 45s 四个阈值改为 S01 模块导出的共享常量，卡片与直播室桥
  不再各自维护魔数。
- `tests/feishu-progress-system-info.test.ts` 覆盖三个阶段、65 秒耗时、最近 5 条、累计 7 步、成功/
  失败标题、重复工具 tally，以及绝对路径、token、`sk-` 密钥脱敏；测试隔离为纯本地，不发送飞书。

验证均为 exit 0：

- `npx tsc --noEmit`
- S01–S05 目标回归：`harness-events`、`kimi-code-agent`、`pi-agent`、`antigravity-agent`、
  `feishu-progress-system-info`、`live-room-workflows`、`workflow-dispatch-recovery`
- 直播室回归：handoff、handoff-boundaries、handoff-plan、scheduling、directed-protocol、permissions、
  feishu-live-room-relay
- `npm run check:long-files`（无文件达到 1000 行）
- `git diff --check`

## 真人/真机证据

目标房间为 `Feishu DM 08a216`（`cmptelg600006hc7fne4syahb`），绑定飞书 DM
`oc_b634823504e29e6220de0cfb5108a216`。

展示层真机卡使用实际飞书 API 发送并成功 finalize：

- 消息 ID：`om_x100b68e31e5a1d0cb4c6b0370f30575`
- 输入依次包含思考、两次相同 `Read`、`Typecheck`、等待心跳和成功摘要。
- 输入故意包含工作区绝对路径、`token=secret-value` 与 `sk-secret123`；自动化对同一卡片结构断言这些
  原文均不可见，重复 `Read` tally 为 `×2`。
- 发送日志确认卡片编辑节流为 1500ms。环境缺少 `lark-cli`，无法用 `lark-im` 再次只读拉取消息；
  飞书 API 返回的消息 ID与执行日志保留为真机证据。

三种成员真人回复均创建了真实进度卡，但随后失败：

| Harness | 直播室源消息 | 飞书进度卡 | 结果 |
| --- | --- | --- | --- |
| kimi-code | `cmsr7i5410001cvrs15627arp` | `om_x100b68e309e13cb8b1014450538423a` | `project mold-data-webpage-tool.path does not exist` |
| pi-agent | `cmsr7j64v0001w5ky53mwmcf6` | `om_x100b68e304e65cb0b24796bdcea8300` | `project workflow-test.path does not exist` |
| antigravity | `cmsr7jhjp00016k8miliiy1x9` | `om_x100b68e305d4acb0b156df44ff1cb6b` | `project mold-data-webpage-tool.path does not exist` |

失败发生在 harness 启动前，未产生思考/工具事件，故不能据此验收持续进度、事件折叠或成功结束态。
同一房间已有 fast `/run` 的 codex → pi-agent 两阶段完成记录，自动化也覆盖每阶段独立 tracker；但本次
S06 新卡片布局尚未在一个成功的真人 `/run` 中完成验证。

## 阻塞与复验条件

修复成员所引用项目的有效 `path`（或将成员绑定到当前存在的项目）后，按原 S06 步骤重新触发三位成员
和一次至少两阶段的 `/run`。需要逐项确认持续思考/工具、脱敏、折叠聚合、阶段切换，以及成功/失败结束
卡；全部通过后再把 PLAN 417 标记为 complete。
