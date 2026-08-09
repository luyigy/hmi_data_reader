---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/383_PLAN_20260804_Inbox优先级议题实施.md
slice: S03
plan_progress: complete
---

# HANDOVER · S03 Specialty 显式覆盖（“亲自写” override 热修）

## 背景

383_PLAN S03 已交付 `specialty=documentation` 的意图路由（`resolveDocumentationTarget`：
文档类自由消息自动转交文档专员）。但首版**无 opt-out**：一旦命中文档意图且房间存在文档专员，
即使运营者显式 @ 了别的成员，仍会被强制转给专员，无法做到“这次就让被 @ 的人写”。

本热修为 S03 追加**显式覆盖（override）**能力：消息正文出现 `亲自 / 你自己 / 直接` +
`写 / 整理 / 记录 / 提交`（如“亲自写”“你自己整理”“直接提交”）时，**抑制专员路由**，
消息按 @ / 解析目标派发，归运营者指定的人处理。

> 说明：这是一次对已完成 S03 的**事后热修**（`e180336`），不开启新 Slice，
> 故采用 `await_acceptance` 终态等待验收，不触发 watcher 推进下一 Slice。

## 改动内容（commit `e180336` · 2026-08-09 16:40）

`src/lib/live-room-messages.ts`

- 新增正则 `DOCUMENTATION_SPECIALTY_OVERRIDE = /(?:亲自|你自己|直接)(?:来)?(?:写|整理|记录|提交)/`。
- `resolveDocumentationTarget` 在原条件 `!mentionedAll && detectDocumentationIntent(content)` 之上
  增加 `&& !DOCUMENTATION_SPECIALTY_OVERRIDE.test(content)`：命中覆盖词即不返回专员，
  `targetMemberId` 回退为 `resolvedTargetMemberId`（即 @ / 解析目标）。
- 大小写敏感、无 `/i`；必须同时命中“人称词 + 动词”才触发（如“亲自写”触发，“亲自”单独不触发）。

`tests/documentation-intent-routing.test.ts`

- 新增第 4 条断言：`@codex 这个文档你亲自写` → `targetMemberId === 'mentioned'`（不转专员）。

## 两条路径复测

用项目测试运行器执行（`node --test` 会因无扩展名 ESM 导入失败，必须用 ts-node + 路径别名）：

```bash
TS_NODE_BASEURL=. \
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
node -r ts-node/register/transpile-only -r tsconfig-paths/register \
tests/documentation-intent-routing.test.ts
```

结果：`EXIT=0`，5 条断言全部通过，覆盖：

| # | 输入摘要 | 路径 | 预期 | 结果 |
|---|---|---|---|---|
| 1 | `@codex 写个 FIX 文档记录这个问题` | 默认转交 | 转专员 `documenter` | ✅ |
| 2 | `现在你提交个文档…`（无显式 @） | 默认转交 | 转专员 `documenter` | ✅ |
| 3 | `@codex 修复这个问题`（非文档意图） | 不路由 | 留 `mentioned` | ✅ |
| 4 | `@codex 这个文档你亲自写` | **显式覆盖** | 留 `mentioned`（抑制专员） | ✅ |
| 5 | `@all 写个 FIX 文档记录这个问题` | @all 不路由 | `null` | ✅ |

- **默认转交路径** ✅：命中文档意图、非 @all、无覆盖词、房间有 `specialty=documentation && canReply`
  成员 → 转专员（断言 1、2）。
- **显式覆盖路径** ✅：同上但正文命中 `亲自写` → 抑制专员，按 @ 派发（断言 4）。

> 前置条件：路由仅在房间存在 `specialty=documentation && canReply` 成员时激活；
> 若本房间无此类成员，两条路径都不会触发（消息按常规 @ 派发）。

## 验收入口

1. 上述单测命令，期望 `EXIT=0`。
2. 房间内（已配文档专员）发文档意图消息 → 应转专员；同一消息加“亲自写” → 应留给被 @ 者。

## 遗留 / 范围外

- 覆盖词为静态正则；如需更丰富的触发（如纯英文 `you write it`）需扩 `DOCUMENTATION_SPECIALTY_OVERRIDE`。
- `diagnostics / implementation` 两个 specialty 枚举值仍只存不路由（与 S03 现状一致，未变）。
- Web Dashboard 仍未展示 `specialty` 字段（S03 遗留，未在本热修范围）。
