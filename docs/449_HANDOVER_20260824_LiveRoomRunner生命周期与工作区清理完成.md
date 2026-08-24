---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/448_PLAN_20260824_LiveRoomRunner生命周期与工作区清理.md
slice: S01
plan_progress: complete
---

# HANDOVER · LiveRoomRunner生命周期与工作区清理完成

## 完成内容

1. 删除离线 Remote Runner 时，在同一事务中将匹配的 LiveRoom 历史成员标记为 `removed`、
   `canReply=false`、`offline`；重新注册并加入房间时恢复同一成员，保留历史记录。
2. Handoff 不再路由给 removed、不可回复或 offline 成员；同一目标被重复提及时只计一个目标。
   显式 mention 优先于文档专项自动路由。
3. `/ap nick` 在事务中清除历史成员占用的同名昵称，再赋给当前成员；房间创建卡等待最新 Agent
   目录刷新，刷新失败保留上次缓存；权限控制卡展示当前房间权限。
4. 科学试模助手 watcher 的 `ref` 与 `branch_space` 独立切换到 `dev`。

## 提交

- `f1c3336 fix(live-room): stabilize remote runner membership`
- `7e99cb0 config(workflow): follow mold dev branch`

## 验证

- `npm run test:acpx-harness-options`：通过。
- `npm run test:dashboard-visibility`：通过。
- `npm run test:feishu-room-create-card`：通过；日志中的 `catalog unavailable` 为故意模拟刷新失败。
- `tests/feishu-help-command.test.ts`、`tests/feishu-members-command.test.ts`、
  `tests/live-room-handoff.test.ts`、`tests/live-room-permissions.test.ts`、
  `tests/documentation-intent-routing.test.ts`：通过。
- `npx tsc --noEmit`、`npm run check:long-files`、`git diff --check`：通过。
- 未运行 `npm run build`：该仓库已有记录表明共享 `.next` 时会干扰正在运行的 dev 服务；本轮以
  TypeScript 与聚焦测试覆盖受影响路径。

## 接口与数据影响

- 无 API 响应契约、数据库 Schema、migration、审批、导出或新增依赖变化。
- 删除 Remote Runner 现在会同步改变对应 LiveRoomMember 的路由状态，但保留成员与消息历史。
- `config/projects.yaml` 的 watcher 目标已改为 `refs/heads/dev` / `dev`；未启动 watcher、未重启服务。

## 已知限制与验收建议

- 未执行真实飞书卡片点击、Remote Runner 断开/重连和 watcher 运行态验收。
- 验收时建议删除一个离线测试 Runner，确认其成员不再被路由；重新配对后再次加入，确认历史成员恢复。

## 下一会话验收提示

读取 `docs/449_HANDOVER_20260824_LiveRoomRunner生命周期与工作区清理完成.md`、
`docs/448_PLAN_20260824_LiveRoomRunner生命周期与工作区清理.md` 和
`docs/workflow/workflow-contract.yaml`，验收 S01；如无新问题，不继续实施。
