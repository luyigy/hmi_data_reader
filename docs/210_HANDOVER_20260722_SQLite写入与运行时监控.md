# 210_HANDOVER_20260722_SQLite写入与运行时监控

## 任务类型

bugfix / feature / test / docs

## 所属主线

临时插队：阻塞飞书 standalone runtime 稳定性，必须立即修。

## 为什么做

ACPX 流式回复结束时，`prisma.taskRunParticipant.update()` 偶发 SQLite timeout。根因是 harness 以 fire-and-forget 方式并发触发 chunk 回调，每个小文本块又产生多次 SQLite 写入，导致写锁争用和写放大。历史上 standalone runtime 还出现过单进程约 396 个线程、约 350 个 SQLite 文件句柄，需要可见的运行时指标防止复发而不自知。

## 修改内容

- `src/lib/acpx/stream-write-buffer.ts`：将相邻 stdout/stderr chunk 合并，100ms 串行批量持久化，并支持结束前 drain。
- `src/lib/acpx/runner.ts`：流式状态更新改为单事务批量写入；成功或失败收尾前清空缓冲，避免最终状态与未完成 chunk 写入竞争。
- `src/lib/prisma.ts`：SQLite 初始化启用 WAL 和 5 秒 `busy_timeout`，失败后允许重试。
- `src/lib/feishu-runtime-status.ts`：按需读取 `/proc/<pid>`，采集线程、总文件句柄、SQLite 文件句柄和 RSS；不增加 standalone 定时线程或数据库写入。
- `src/components/dashboard/FeishuRuntimeMonitor.tsx`、`src/app/page.tsx`：Dashboard 每 10 秒展示指标和页面内增量；线程 ≥100 或 SQLite 句柄 ≥25 为 warning，线程 ≥250 或 SQLite 句柄 ≥100 为 critical。
- `src/lib/feishu.ts`：现有 `/ap status` 增加 standalone runtime 指标，无需新增重复命令。
- 新增两个最小测试，覆盖流式合并/drain 和运行时阈值分类。

## 验证结果

- `npx tsc --noEmit`：通过。
- 相关文件定向 ESLint：除 `src/lib/feishu.ts` 原有未使用导入外通过；该存量问题不属于本轮改动。
- `tests/stream-write-buffer.test.ts`：通过。
- `tests/feishu-runtime-metrics.test.ts`：通过，`396 threads / 350 SQLite FDs` 判定为 critical。
- Prisma 实测返回 `journal_mode=wal`、`busy_timeout=5000`；`PRAGMA integrity_check` 为 `ok`。
- GitNexus 最终变更检测包含工作区其他未提交开发，整体风险为 high；本轮涉及的高风险入口为 ACPX participant 执行、飞书状态读取和 `/ap status`，均保留原接口并以只读/批量方式实现。

## 对主线的影响

移除 SQLite timeout 与流式写放大的主要根因，并补齐 Web Dashboard 与飞书侧的运行时泄漏观测。未加入自动杀进程或 systemd 硬限制，避免正在执行的任务被无提示中断。

## 下一步建议

1. 重启 `agent-platform-feishu.service`，让 standalone 加载新的 `/ap status` 输出。
2. 在飞书发送 `/ap status`，确认线程、FD、SQLite FD、RSS 均可读取。
3. 长时间运行后观察 Dashboard 增量；只有确认仍持续增长时，再增加带优雅退出的自动重启策略。
