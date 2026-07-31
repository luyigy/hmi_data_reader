---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: null
slice: null
plan_progress: complete
---

# HANDOVER · Antigravity 真实上下文水位及 StreamJson 遥测完成

## 完成内容

- 新增 `src/lib/real-agents/antigravity-context.ts`：
  - 支持解析 Antigravity (`agy 1.1.8`) `stream-json` 输出事件中的 `input_tokens` 真实使用量，并基于模型标识与缺省上限（默认 1,048,576）确定 `contextWindow`；
  - 提供 `getAntigravityProviderContextUsage` 用于读取与校验 `controlMetadata` 中 24 小时内的 Antigravity 上下文用量；
  - 提供 `persistAntigravityContextUsageMetadata` 将 `antigravityContextUsage` 持久化至数据库 `TaskRunParticipant.controlMetadata`。
- 新增 `tests/antigravity-context.test.ts`：
  - 覆盖 JSON 流解析、后向遍历最新结果、正则降级提取、TTL 过期判定、百分比限制与负数非法用量保护，8 项单测全部通过。
- 修改 `src/lib/real-agents/antigravity-agent.ts`：
  - 调用 `agy` 时显示加上 `--output-format stream-json` 参数；
  - 增加 `extractAntigravityResponse` 以解析 `stream-json` 事件中的 final response，兼容文本与流式返回；
  - 并在执行结束时解析 `contextUsage` 挂载至 `AntigravityResult`。
- 修改 `src/lib/harness/types.ts` 与 `src/lib/acpx/runner-harness.ts`：
  - 扩展 `HarnessExecuteResult` 增加 `contextUsage?: AntigravityContextUsage`；
  - 在 `antigravity` 执行成功后自动调用 `persistAntigravityContextUsageMetadata`。
- 修改 `src/lib/live-room-members.ts` 与 `src/lib/acpx/prompt.ts`：
  - 去除对 `antigravity` 硬编码为 `not_applicable` 的限制，支持提取 `antigravityContextUsage`；
  - 当 Antigravity 在 Session 中产生真实遥测时显示 `用量 X% (provider)`，并在达到 60%（提示）与 85%（警告重置）时在系统 Prompt 中注入 `/ap new-session` 引导。

## 验证

- `tests/antigravity-context.test.ts` 8 项测试：通过。
- `npx tsc --noEmit` 静态类型检查：0 Error 通过。
- `npm run check:long-files`：通过，无文件达到 1000 行限制。
- `git diff --check`：通过，无空格或换行问题。
- 本地 CLI 实测：`agy -p "hi" --sandbox --output-format stream-json` 可稳定解析 `usage: { input_tokens: 16223 }`。

## 验收方式

重启飞书服务后在绑定 Live Room 中向 Antigravity 发送命令：
```text
/ap chat @antigravity 你好
```
运行完成后执行 `/ap members`，验证 Antigravity 是否正确展示 `用量 XX% (provider) | 策略 within policy` 水位状态。
