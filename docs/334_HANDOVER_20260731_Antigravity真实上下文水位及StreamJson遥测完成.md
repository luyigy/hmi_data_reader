---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: null
slice: null
plan_progress: complete
---

# HANDOVER · Antigravity 单次运行遥测与严格未识别模型 Null 保护完成

## 修正与完成内容

遵照验收意见，对 Antigravity CLI 遥测语义与模型分母推断逻辑进行了彻底纠正：

1. **未识别模型时绝对返回 `null`（禁止默认 1M 猜数值）**：
   - `resolveAntigravityContextWindow(modelAlias)` 未识别或缺失模型标识时返回 `null`；
   - `getAntigravityProviderContextUsage` 当 `contextWindow` 为 `null` 时，`usagePercentage` 输出为 `null`，禁止推算假百分比。
2. **Antigravity 上下文状态维持 `not_applicable`**：
   - 遵照 `docs/326_PLAN_20260730_Antigravity与Kimi真实上下文水位及账户Quota.md:61` 规范，Antigravity 当前在 Platform Local Adapter 中无跨 turn continuation，故 `source` 保持 `not_applicable`；
   - 不参与跨轮 Session 轮换、不冒充 Session 水位、不触发 60%/85% 的 `/ap new-session` 警告 Prompt。
3. **单次运行 Usage 显式标注为 `last run usage`**：
   - 将 `usedTokens` 明确命名并标注为 `lastRunInputTokens`；
   - 在房间成员卡片与 UI 诊断中明确显示 `last run usage: X tokens`，避免与 Session 跨轮水位混淆。
4. **真实 `agy 1.1.8 stream-json` 样本测试与断言**：
   - 提取本机真实运行 `agy -p "hi" --sandbox --output-format stream-json` 产生的无 model 字段原始事件样本写入 `tests/antigravity-context.test.ts`；
   - 断言：无 model 标识的真实事件解析出的 `contextWindow` 必须为 `null`，且 `usagePercentage` 必须为 `null`（不计算百分比）。

## 关联文件

- `src/lib/real-agents/antigravity-context.ts`
- `src/lib/real-agents/antigravity-agent.ts`
- `src/lib/live-room-members.ts`
- `src/lib/acpx/prompt.ts`
- `src/lib/live-room-types.ts`
- `src/types/index.ts`
- `tests/antigravity-context.test.ts`

## 验证

- `tests/antigravity-context.test.ts` 9 项聚焦测试：全部通过。
- `npx tsc --noEmit` 静态类型检查：0 Error 通过。
- `npm run check:long-files` & `git diff --check`：全部通过。

## 验收方式

在绑定 Live Room 执行 `/ap members`，验证 Antigravity 是否正确保持：
- 上下文状态为 `not_applicable` / `fresh conversation per turn`；
- 无 /ap new-session 重置警告；
- 遥测诊断明确标注单次运行输入 Token 占用。

