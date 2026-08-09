# FIX · Live Room 多 Agent 接力中断

## 问题

用户要求 antigravity、pi、kimi-code 接力讨论时，pi 最终只输出了 `@kimi-code`，没有触发 kimi-code，讨论提前结束。

## 根因

- Live Room Prompt 使用字面占位符 `$member` 描述 handoff，模型可能照抄无效 token。
- 首个显式短别名（如 `$lag，`）会遮蔽同一句中的后续普通成员名，平台没有保存完整接力顺序。
- 后续 agent 未输出有效 handoff token 时，平台没有利用原始计划队列兜底。

## 修复

- Prompt 直接列出可用的 canonical handoff tokens，不再展示 `$member` 占位符。
- 首个目标支持短别名及中文标点剥离，并从原始消息提取后续成员顺序。
- 将剩余成员 ID 写入消息 metadata；后续 agent 没有显式 handoff 时按队列自动接力。
- 无法解析的 `$...` 文本不再直接判作未知目标，避免 LaTeX 或无效占位符阻断计划队列兜底；多个真实目标仍会被拒绝。

## 验证

- 回归用例覆盖 `$lag，你和 B、C 依次讨论`，确认保存并执行 `[B, C]`。
- 覆盖 canonical token Prompt、短别名剥离、metadata 剩余队列、无效 token 与 LaTeX 场景。
- 类型检查、目标测试、长文件守卫及 `git diff --check` 通过。
- 用户已在真实飞书群中人工测试并确认可以正常接力。
