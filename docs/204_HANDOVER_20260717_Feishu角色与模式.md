# 204_HANDOVER_20260717_Feishu角色与模式

## 任务类型
feature / docs

## 所属主线
Workspace 多 Agent 协作

## 为什么做
Feishu 创建 Live Room 时虽然已支持 mode 和角色调度，但只能在 Web UI 修改成员角色；同时 `/ap agents` 展示的 platform-local canonical ID 过长，不适合手工输入。

## 修改内容
- `/ap agents` 对本机 Agent 展示 `local:<harness>` 短写，不迁移或修改内部 canonical ID。
- `/ap help` 使用 `local:codex,local:claude` 演示房间创建。
- 新增 `/ap role --member=<成员> --role=<角色>`，支持：
  - `planner`
  - `researcher`
  - `implementer`
  - `reviewer`
  - `tester`
  - `custom`
- 兼容用户常用拼写 `implementor`，写入时统一为 `implementer`。

示例：

```text
/ap room --agents=local:antigravity,local:codex,local:claude --topic=sci-molding-dev --workdir=/data1/code/mold-data-webpage-tool --profile=full --mode=execution sci-molding-dev
/ap nick --member=antigravity --name=lag
/ap nick --member=claude --name=lcc
/ap nick --member=codex --name=lcx
/ap role --member=lag --role=tester
/ap role --member=lcc --role=implementer
/ap role --member=lcx --role=reviewer
```

## Mode 行为

### discussion
- 有显式 mention 或定向目标时，仅目标成员回复。
- 没有显式目标时，仅当前 speaker 回复。
- 不自动运行完整角色队列。

### execution
- 没有显式目标时，所有可回复成员按角色顺序串行执行。
- 固定顺序为：
  `planner → researcher → implementer → reviewer → tester → custom`
- 同角色成员按房间内 `sortOrder` 排序。
- 每个 delivery 完成后才启动下一个成员。
- 有显式目标时只执行该目标，不启动完整角色队列。
- 对本例的三个成员，顺序为：
  `lcc (implementer) → lcx (reviewer) → lag (tester)`。

### hybrid
- 普通消息按 discussion 处理。
- `/run <任务>` 启动与 execution 相同的角色队列。

### 共同例外
- `$all` 会要求所有可回复成员按顺序回应，不依赖 room mode。
- `/ap mode discussion|execution|hybrid` 可修改已绑定房间的 mode。
- `/ap room ... --mode=...` 可在创建或复用绑定房间时设置 mode。

## 验证结果
- `npx tsx tests/feishu-mode-command.test.ts`：通过。
- `npx tsx tests/live-room-scheduling.test.ts`：通过。
- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。
- 仍需重启 Feishu runtime 后进行真实 Feishu 命令烟测。

## Feishu 模块化计划
`src/lib/feishu.ts` 当前约 2175 行。本次只做窄改动；后续按稳定职责逐步提取，不做纯行数拆分。

1. 提取 `feishu-command-parser.ts`
   - command 类型、help 文本、tokenizer 和 `parseFeishuCommand`。
   - 纯逻辑、依赖少，最适合作为第一步。
2. 提取 `feishu-room-commands.ts`
   - `room`、`mode`、`members`、`nick`、`role`、`speaker`、`add`、`kick`、`workspace`。
   - 统一复用现有成员查询规则，避免每个命令重复 nickname/alias/id 匹配。
3. 提取 `feishu-session-commands.ts`
   - `handover`、`new-session` 及其路径、权限和 prompt helpers。
4. 提取 `feishu-admin-commands.ts`
   - `status`、`gateways`、`agents`、`hosts`、`register`、`run`。
5. 保留 `feishu.ts`
   - webhook 验签、payload/message 解析、资源 hydration 和顶层 command dispatch。

每一步单独提交并运行现有 Feishu parser、mode scheduling 和 TypeScript 检查；只有出现真实复用点时才增加共享 abstraction。

## 其他大文件候选
按当前行数和职责混合程度排序：

1. `src/app/tasks/[id]/chat/page.tsx`（约 2456 行）
   - 优先提取消息列表、composer、run/approval 状态 hooks 和侧栏组件。
2. `src/components/live-room/LiveRoomWorkspace.tsx`（约 2140 行）
   - 优先提取房间创建表单、成员管理、消息面板和 room data hooks。
3. `src/lib/live-room-delivery.ts`（约 1949 行）
   - 按 target selection、delivery lifecycle、ACPX execution、chain/mention handling 拆分。
4. `src/lib/acpx/runner.ts`（约 1895 行）
   - 按 run preparation、process execution、stream/event persistence 和 completion handling 拆分。
5. `src/lib/live-room.ts`（约 1657 行）
   - 按 catalog/selector、member identity、task synchronization 和 message/context serialization 拆分。

暂不优先处理低于 1000 行的文件；只有在相关功能修改触及它们且职责继续增长时再提取。

## 对主线的影响
Feishu 已可完成本机 Agent 选择、昵称、职责、权限和 mode 配置，减少创建软件协作房间时对 Web UI 的依赖。

## 下一步建议
1. 重启 Feishu runtime，执行本文示例命令并确认角色队列为 `lcc → lcx → lag`。
2. 下一次需要修改 Feishu parser 或新增命令时，先执行 `feishu-command-parser.ts` 提取，不单独发起大爆炸式重构。
