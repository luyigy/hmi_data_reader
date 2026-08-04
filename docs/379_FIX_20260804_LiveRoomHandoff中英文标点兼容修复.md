---
doc_type: FIX
doc_status: completed
next_action: none
---

# FIX · Live Room Handoff 中英文标点兼容修复

## 问题描述

在 Live Room 飞书/Chat 消息交付中，当用户使用中文句号、感叹号、逗号等中英文标点紧接在 `$member` 前面（例如 `安排。$kimi-code` 或 `收到！$codex`）时，以前的转交正则前缀匹配规则 `(^|[\s(])` 仅支持字符串开头、空白符或左括号 `(`。

这导致紧跟在中英文标点（如 `。` `！` `，` `；` `.` `,` `;` `!` 等）后的 `$member` Handoff 意图识别失败，未能触发意图转交。

## 根因分析

在 `src/lib/live-room-handoff.ts` 中：
- 常量 `MENTION_BOUNDARY` 已定义包含全面中英文标点的字符集：
  `[\s,.;:!?\/()\[\]{}"'，。；：！？】【、】【（）《》]`
- 但 `HANDOFF_PREFIX` 此前硬编码为 `'(^|[\\s(])'`，未复用 `MENTION_BOUNDARY` 集合。
- 这导致只有空格或左括号前缀的 `$member` 能被成功匹配为转交意图。

## 修复方案

修改 `src/lib/live-room-handoff.ts` 中的 `HANDOFF_PREFIX`，复用现有的 `MENTION_BOUNDARY` 常量：

```ts
const HANDOFF_PREFIX = `(^|${MENTION_BOUNDARY})`;
```

支持匹配所有在 `MENTION_BOUNDARY` 定义的中英文标点后的 `$member` Handoff 意图。

## 改动点

1. **`src/lib/live-room-handoff.ts`**
   - 将 `HANDOFF_PREFIX` 修改为 `(^|${MENTION_BOUNDARY})`，实现中英文标点兼容。
2. **`tests/live-room-handoff.test.ts`**
   - 新增回归测试用例：
     `detectLiveRoomHandoffIntent({ content: '安排。$B', members, senderMemberId: 'a' })`
     断言返回 `{ kind: 'target', targetMemberId: 'b' }`。

## 验证情况

- `TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/live-room-handoff.test.ts`
  - 单元测试通过。
- `npx tsc --noEmit`
  - TypeScript 类型检查通过。
- `npm run check:long-files`
  - 长文件规范校验通过。
