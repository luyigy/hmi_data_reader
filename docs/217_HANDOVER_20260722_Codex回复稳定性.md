# 217_HANDOVER_20260722_Codex回复稳定性

## 任务类型
bugfix / docs

## 所属主线
临时插队；修复 Feishu Live Room 的 Codex 过程消息刷屏、正常退出误报失败和长任务无进度感知。

## 为什么做

Codex app-server 的 `item/agentMessage/delta` 是 token 增量，旧链路将其逐条转发到飞书；聚合后又观察到 `Codex app-server exited with code 0` 被当作失败。长工具任务期间，服务控制台仅停在 `[Codex] Executing task`，容易被误认为卡死。

## 修改内容

- `src/lib/live-room-delivery.ts`
  - 在共享出口累计 Codex stdout delta。
  - 到达窗口、工具事件前、失败/结束/最终回复前 flush。
  - 聚合消息标记 `harnessType: codex`、`stream: stdout`、`aggregated: true`。
- `src/lib/feishu-live-room-relay.ts`
  - 只转发明确标记为聚合后的 Codex stdout progress。
  - 旧 progress、其他 harness progress 和 Codex stderr 继续过滤。
- `src/lib/real-agents/codex-app-server.ts`
  - app-server 以 code 0 退出且已有输出时按成功收敛，不再误报失败。
  - 未支持的 server request 返回合法 JSON-RPC `-32601 Method not found` 结构，避免 app-server 反序列化错误。
- 更新对应 relay 和 app-server 最小回归检查。

## 调查证据

- SQLite 中多条失败记录为 `Codex app-server exited with code 0`。
- 最近一次集中失败发生在 Codex 自己重启 `agent-platform-feishu.service` 时；两个运行中会话在同一时间结束。
- 更早失败会话出现 `Failed to deserialize JSONRPCMessage`，对应旧的缺少 JSON-RPC error code 的响应。
- 重启后真实飞书请求成功进入 `running / streaming`，并收到两段 `aggregated: true` progress。
- 所谓“长时间无响应”的当次任务实际在运行 `gitnexus analyze`，约占用 10 个 CPU 核；不是数据库或 app-server 卡死。

## 验证结果

- `npx tsx src/lib/real-agents/codex-app-server.test.ts`：通过。
- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。
- 服务重启后真实 Feishu/Codex run：启动成功、progress 聚合成功、任务持续运行。
- GitNexus：`runCodexAppServer` upstream risk 为 HIGH，2 个直接调用方、3 类流程；只涉及 Codex 新建/恢复入口，不涉及 Claude 或 Antigravity executor。

## 已知边界

- app-server 长工具调用目前没有持续 tool heartbeat；工具执行期间可能静默数分钟。
- Claude/Antigravity 最终回复和 tool 系统消息不受影响，但普通 stdout/stderr progress 当前不会 relay 到飞书。
- 重启 Feishu runtime 会终止正在执行的子进程；重启前应等待运行任务结束。

## 对主线的影响

解除 Codex token 刷屏和 code 0 误报的主要阻塞，并暴露两个后续主线：数据库并发能力与大型文件职责混杂。

## 下一步建议

1. 先观察至少一次完整的长 Codex run，确认 final reply 和末尾 flush。
2. 执行 [215_PLAN_20260722_PostgreSQL迁移](./215_PLAN_20260722_PostgreSQL迁移.md)。
3. 数据库切换稳定后，从 [216_PLAN_20260722_功能内聚重构](./216_PLAN_20260722_功能内聚重构.md) Phase 1 开始。
