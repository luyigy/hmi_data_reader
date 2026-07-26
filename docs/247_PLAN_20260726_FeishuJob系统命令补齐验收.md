---
doc_type: PLAN
doc_status: draft
next_action: await_plan_approval
plan_kind: phase
roadmap: 224_PLAN_20260725_通用项目定时任务平台.md
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Feishu Job 系统命令补齐验收

## 目标

完成 `224_PLAN_20260725_通用项目定时任务平台.md` 的 Slice 5：确保以下命令由
Feishu runtime 作为平台系统命令拦截、执行并回复，不进入 Live Room Agent 对话：

```text
/ap jobs
/ap job status workflow-watcher
/ap job disable workflow-watcher
/ap job enable workflow-watcher
/ap job run workflow-watcher
```

## 当前结论

实现已提交在 `e8470a7 feat(feishu): add scheduled job commands`，Platform Local 的
`agent-platform-feishu.service` 于该提交后重启并已加载代码。五条命令都已有解析和
系统路由，`disable/enable` 使用现有 `enabledOverride`，`run` 使用现有锁、权限、
模式和运行记录。

尚未补齐的是验收，而不是再造一套命令：

| 命令 | 实现 | 当前缺口 |
| --- | --- | --- |
| `/ap jobs` | 已有 | 未验证真实会话绑定、系统预设回复和运行态列表 |
| `/ap job status workflow-watcher` | 已有 | 无 handler/系统路由测试 |
| `/ap job disable workflow-watcher` | 已有 | 无权限、幂等和 Runner 停止后续触发测试 |
| `/ap job enable workflow-watcher` | 已有 | 无权限、幂等和恢复触发测试 |
| `/ap job run workflow-watcher` | 已有 | 无权限、锁、模式、运行记录和失败回复测试 |

现有 `tests/feishu-job-command.test.ts` 只验证 `/ap jobs`、`disable` 两个解析结果，以及
缺少 webhook context 时的一条回复；异步断言也没有由顶层 `await` 保证完成。它不能证明
五条命令在 Feishu runtime 中被系统处理。

## 实施计划

### S01：补命令层回归测试

1. 对实际拟修改 symbol 重新执行 GitNexus upstream impact。
2. 扩充现有单个测试文件，不新增测试框架：
   - 五条命令全部可解析；
   - `handleFeishuCommand` 将 `jobs/job` 路由到系统 handler；
   - 未绑定会话、未知 job 和非法 action 返回固定错误；
   - `jobs/status` 返回项目配置、override、running/idle 和最近执行状态；
   - 非管理员、非审批人不能 `enable/disable/run`；
   - 重复 `enable/disable` 结果幂等；
   - `run` 留下 `manual` 运行记录，并遵守 shadow、锁和幂等。
3. 测试只使用隔离的项目/job 和可清理数据库记录，不改真实
   `workflow-watcher` override，不发送飞书消息，不启动 Session。

验收：测试必须经过真实 parser → `handleFeishuCommand` → scheduled-job handler 链，
不能只调用 parser。

### S02：只修测试暴露的最小缺口

1. 若五条命令行为符合计划，只保留测试，不重写实现。
2. 若系统回复无法区分手动执行失败与锁冲突，在
   `handleScheduledJobCommand` 内利用本次 run 记录生成准确回复。
3. 不改变 `executeScheduledJob` 返回类型。其 GitNexus upstream impact 为 CRITICAL：
   4 个直接调用方、8 条执行流程；除非发现 Runner 根因且先向用户告警，否则不得修改。
4. 不增加 command class、service interface、factory、队列、API 或数据库模型。

验收：改动限制在命令 handler 和一个测试文件；只有 parser/路由确有缺陷时才修改对应
现有文件。

### S03：Platform Local 验收

1. 运行：
   - `npx tsc --noEmit`
   - Feishu job 命令测试
   - `npm run test:scheduled-jobs`
   - `npm run test:workflow-watcher`
   - `git diff --check`
2. 运行 GitNexus `detect_changes()`，确认只影响 Feishu 命令和 Scheduled Job 预期流程。
3. 提交后重启 `agent-platform-feishu.service`；若 Runner 代码未改，不重启
   `agent-platform-scheduled-jobs.service`。
4. 在当前 Feishu DM 依次人工验收五条命令：
   - 回复来自平台系统，不创建 Codex TaskRun；
   - `disable` 后状态为 disabled，后续 schedule/完成事件不触发 watcher；
   - `enable` 后恢复；
   - `run` 生成唯一 manual run，并返回真实执行结果。
5. 验收结束保持用户指定的最终 enabled 状态；若未指定，恢复验收前状态。

## 停止条件

- 需要修改 CRITICAL 的 `executeScheduledJob`：先停止并报告影响范围。
- 测试可能触发真实 workflow 副作用、创建 Session 或发送消息：改用隔离 job，不在真实
  watcher 上试错。
- 当前工作区的 `AGENTS.md`、`CLAUDE.md` 属于既有用户修改，不纳入提交。

<!-- WORKFLOW_PROMPT_START -->
按 `docs/247_PLAN_20260726_FeishuJob系统命令补齐验收.md` 完成 S01—S03。先保留工作区
既有 `AGENTS.md`、`CLAUDE.md` 修改，并对每个拟修改 symbol 做 GitNexus upstream
impact；HIGH/CRITICAL 先告警。复用提交 `e8470a7` 的现有实现，重点补 parser →
`handleFeishuCommand` → scheduled-job handler 的真实系统路由、权限、项目隔离、幂等、
override、manual run 和预设回复测试。不要修改 CRITICAL 的 `executeScheduledJob`
返回类型，不新增抽象、依赖、API 或数据库模型。测试不得改变真实 workflow-watcher
状态或产生 Feishu/Session 副作用。通过 TypeScript、scheduled-jobs、workflow-watcher、
聚焦测试、`git diff --check` 和 GitNexus `detect_changes()` 后提交，重启 Feishu
runtime，并在当前 DM 人工验收五条命令；结束时恢复验收前 enabled 状态。
<!-- WORKFLOW_PROMPT_END -->
