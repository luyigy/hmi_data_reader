---
doc_type: REPORT
doc_status: completed
next_action: none
---

# REPORT · Workflow Watcher 与自治模式操作参考

## 文档定位

本文记录 workflow-watcher、自治模式和飞书命令卡片的实际关系，供操作与验收参考。本文不是 PLAN 或
HANDOVER，不包含 workflow Prompt，也不会触发自动推进。

## 两个独立控制面

`workflow-watcher` 的启停与 `workflow autonomy` 是两个独立开关：

| Watcher | 自治模式 | 行为 |
| --- | --- | --- |
| disabled | 任意 | 不定时扫描新的已提交 PLAN/HANDOVER，自治模式不生效 |
| enabled | manual | 定时扫描、校验和展示状态；不自动启动下一 Slice，需手工运行 watcher |
| enabled | semi_auto | 只在当前已批准 PLAN 内自动推进下一 Slice，并按可信水位决定复用或换代 Session |
| enabled | auto | 包含 semi_auto 行为；父 PLAN 完成后还可从 Roadmap/Inbox 提议下一 PLAN |

`auto` 不会绕过 blocked、自动批准新 PLAN 或在没有可执行文档时凭空启动 Session。新 PLAN 始终需要用户
审批。

## 常用文本命令

```text
/ap workflow status
/ap workflow autonomy show
/ap workflow autonomy set manual --head=<当前40位HEAD>
/ap workflow autonomy set semi_auto --head=<当前40位HEAD>
/ap workflow autonomy set auto --head=<当前40位HEAD>
/ap dashboard
/ap job diagnose workflow-watcher
/ap job enable workflow-watcher
/ap job disable workflow-watcher
/ap job run workflow-watcher
/ap job cursor workflow-watcher --latest
/ap job cursor workflow-watcher --clear-pending
```

切换自治模式必须携带当前 HEAD，防止用户基于过期仓库状态改变执行策略。移动 cursor 或清除 pending
会改变恢复状态，只应在只读 diagnose 后使用。

## 飞书卡片覆盖

AP 命令中心的 Workflow 分类已经提供：

- Workflow Dashboard；
- Workflow 状态；
- Jobs；
- Workflow 权限策略；
- workflow-watcher 诊断。

进入 Workflow Dashboard 后，卡片已经提供：

- 刷新；
- 立即运行（已启用且未运行时）；
- 启用 / 停用；
- 停止（运行中时）；
- 重发审批卡或恢复修改任务（对应状态出现时）；
- Manual / Semi-auto / Auto 三种自治模式切换。

因此模式切换、启停和手工运行已经有卡片操作入口，不需要在 AP 命令中心首页重复增加按钮。完整文本命令
仍可在 `/ap help 3` 查看；cursor 移动、清除 pending 和调度修改等低频或高影响操作保留为显式命令或专用
表单。

代码入口：

- `src/lib/feishu-help.ts`：AP 命令中心分类、快捷入口和 `/ap help` 文本；
- `src/lib/feishu-scheduled-jobs.ts`：Workflow Dashboard 卡片及其动作；
- `src/lib/feishu-workflow-policy.ts`：自治模式 show/set 与 HEAD 校验；
- `src/lib/scheduled-jobs/workflow-status.ts`：状态和唯一下一步。

## 2026-07-31 真人验收

在 `agent-platform-v2`、`refs/heads/oss-prep` 上完成：

- workflow-watcher 从 disabled 切换为 enabled；
- Validator 成功识别最新 blocked HANDOVER，未启动新 Session；
- semi_auto、auto、manual 三种 override 均成功切换，状态卡正确显示；
- 没有 pending、重试、隔离或最近错误；
- auto 在没有可执行文档时保持空闲；
- 最终保持 `watcher enabled + manual override`，即持续监控和校验、人工控制实际推进。

本次只证明启停、模式切换、空闲和 blocked 安全性。跨 Slice 自动推进、70% Session 换代、父 PLAN /
Roadmap 提议以及 new-session 四类风险确认仍属于单独的真实行为验收。

## 推荐安全顺序

1. `/ap job diagnose workflow-watcher`，确认 cursor 属于当前历史并检查 pending。
2. 必要时由人工决定是否移动 cursor 或清除 pending，不自动猜测恢复点。
3. 启用 watcher，等待一轮后查看 `/ap workflow status`。
4. 在没有可执行文档时测试 `manual → semi_auto → auto → manual`。
5. 正式运行前恢复预期模式；保守默认使用 `manual`。
