# 部署与 footnote 遥测核验

## 已核实的来源

Task Graph 修复为 `fe0c6e3`，遥测修复为 `53fadf5`。本轮得到部署授权后，先在主工作区 fast-forward 合并，再构建。没有手改生产状态、owner、预算或批准快照。

页面、Coordinator 和任务消息服务已在 2026-10-22 08:49:32 UTC 重启，页面 `/api/health` 返回 healthy。飞书主服务仍承载当前 Codex 对话，其最后一次切换必须等待本轮结果落盘及回复完成；最终完成与否以运行时部署回执为准，不能把已安排切换称为已完成。

## 真实执行观察

- M6_BOLE 的 TaskRun 在 08:50:08.151 UTC 开始，08:55:13.204 UTC 之后仍在运行。
- M6_ARBURG 的 TaskRun 从 08:54:29.473 到 08:55:13.204 UTC，两个实际 Codex 的执行区间重叠约 43.731 秒。
- 两者使用不同 Worktree，观察到原生 Thread ID。M6_ARBURG 的 TaskRun completed 只说明这一轮执行结束，不代表 Ticket 通过验收。
- 这些是部署后正常 Coordinator 的自动领取，没有人工批量改写或恢复生产账本。

## 为什么 footnote 两项都为空

房间是系统输入层，footnote 属于执行观测和展示层，与 Task Graph 放行层分开。

1. 模型状态由 `codex-runtime-state.ts` 读取原生 rollout 的本轮 turn_context。该房间的日志已约 200MB，旧代码在文件大于 64MB 时直接放弃读取，服务日志多次出现 rollout exceeds read limit。
2. 上下文用量原来只从 app-server 的 tokenUsage 更新通知进入 `contextTelemetry`。该会话使用 exec JSON 路径，通知不会抵达这一分支。rollout 中实际存在 token_count，但旧代码没有将它归一化为 contextUsage。
3. 数据库里对应记录的 runtimeState 为 null，contextUsage 不存在。卡片显示未知反映了采集缺失，并非实际没有运行模型。

只读回放上一轮实际日志，修复后用时 601ms，得到 gpt-6.1-sol、medium、最近输入 158030、输出 236、窗口 475000。没有回填或篡改历史消息和元数据。

## 实际修改

| 文件 | 修改 |
| --- | --- |
| src/lib/real-agents/codex-runtime-state.ts | 读取独立的原始 session_meta 与最多 64MB 文件尾；从已验证的当前 turn 中同时收集 turn_context 和 token_count |
| src/lib/harness/adapters/codex.ts | 保留 app-server 流式测量优先，缺失时使用同一原生 turn 的用量；execute 和 resume 共用 |
| tests/codex-runtime-state.test.ts | 超过旧大小上限的真实文件回归，以及未绑定、已结束、非法窗口、伪造 response_item 和多 turn 歧义拒绝 |
| tests/codex-runtime-state-native.test.ts | 实际已安装 Codex 的 app-server/exec-json、首次/续接均必须返回会话匹配的用量 |

这次没有把 64MB 上限简单调大。历史文件再大，每次仍最多读取 64MB 尾部加 64KB 头部，保留两秒读取时限。session_meta 必须与原 Thread 匹配，本轮必须有可识别的开始、时间范围和完成证据；app-server 的精确 turn 回执保留原语义。

## 验证及边界

红色回归在 fe0c6e3 的旧采集代码上失败，绿色回归在 53fadf5 通过。实际 Codex 使用确定性本地 provider 验证两种传输的首次与续接，不冒充生产模型验收。另通过 adapter 用量、footnote 展示、归一化用量、TypeScript 和长文件检查。证据在 `docs/evidence/footnote-telemetry-20261022/`。

如本轮开始记录已被文件尾边界截掉、证据歧义、日志未完整落盘或用量过期，仍显示未知。没有用请求的模型名、默认窗口或旧 turn 的值伪造实测数据。新飞书进程开始的下一轮回复才是端到端 footnote 验收点，本轮旧进程的未知值不会被事后涂改。
