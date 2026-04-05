# 65 Feishu Full Access 与交接说明

## 日期

2026-04-05（更新：2026-04-06）

## 背景

本轮目标主要有三部分：

1. 让 Feishu 侧可以给 ACPX agent 授予更高权限，并继续原会话或启动新 run。
2. 明确区分：
   - Feishu / ACPX agent session 的权限
   - 当前这个终端/Codex 对话窗口的权限
3. 让 Feishu 侧 `/ap new-session` 在启动 fresh session 时可以显式指定权限档位，尤其是 `full access`。

已经确认：

- Feishu 里的 `/ap grant full --agent=codex` / `/ap grant full --agent=lcx` 这条链路已生效。
- Feishu 的 `/ap new-session` 已补上显式权限参数入口，可指定 `safe|dev|full`。
- 用户已经在 Feishu 中看到了类似下面的回执，说明 ACPX session 的 full access 授权成功：

```text
✅ 已授予 lcx 完全权限
Task: Live Room · Local Room Test
运行方式：继续原会话
新 run：cmnlvpr0i000qv8z80xubho33
说明：权限变更会在这次 continuation / new run 生效，不会原地热切换旧进程。
```

## 本轮代码改动

### 1. Feishu 文本授权命令

修改文件：

- `src/lib/feishu.ts`

新增/接入了两个命令：

- `/ap grant <dev|full> [--agent=<name>] [message]`
- `/ap rights [--agent=<name>]`

其中：

- `/ap grant ...` 会直接：
  - 更新 task 的 `acpxPermissionConfig`
  - 优先 continuation 已存在的 session
  - 如果没有 continuation session，则启动新 run
- `/ap rights ...` 会发送一张授权卡片到当前 Feishu 会话

### 2. Feishu interactive 消息发送能力

修改文件：

- `src/lib/feishu-api.ts`

新增：

- `sendFeishuInteractiveMessage(...)`

用于发送 Feishu 交互卡片消息。

### 3. 权限授予共用逻辑

新增文件：

- `src/lib/feishu-grant.ts`

职责：

- 解析 `grant profile`
- 构建 `full_access` / `dev_local` 对应权限配置
- 更新 task 权限配置
- 写入 task room 消息
- continuation 或拉起新 run
- 生成/校验卡片跳转 token

### 4. Feishu 授权落地页

新增文件：

- `src/app/api/feishu/grant/route.ts`

当前实现方式：

- `/ap rights` 发出的卡片按钮会打开：
  - `/api/feishu/grant?token=...`
- 该路由会执行授权动作并返回一个 HTML 结果页

### 5. Feishu new-session 显式权限档位

修改文件：

- `src/lib/feishu.ts`

新增能力：

- `/ap new-session --handover="docs/xx.md" --profile=full "codex"`
- 支持别名：
  - `--profile=safe|dev|full`
  - `--rights=safe|dev|full`
  - `--permission=safe|dev|full`
  - `--access=safe|dev|full`

当前行为：

- 未指定时：沿用 task 当前保存的 `acpxPermissionConfig`
- 指定 `--profile=full` 时：本次 fresh session 以 `full_access` 配置启动
- 指定 `--profile=dev` 时：本次 fresh session 以 `dev_local` 配置启动
- 指定 `--profile=safe` 时：本次 fresh session 回到 `safe_local`

补充说明：

- `src/lib/real-agents/codex-agent.ts` 底层本来就支持 `danger-full-access`
- 对 local codex，会映射到 Codex CLI 的高权限启动参数

### 6. 关键 bug 修复：syncLiveRoomSourceTask 不再覆写 acpxPermissionConfig（2026-04-06 新增）

修改文件：

- `src/lib/live-room.ts`

**这是本轮最终确认的核心根因修复，见下方"问题根因"一节。**

## 问题根因分析（最终版）

### 现象

用户执行：

```text
/ap new-session --handover="docs/65_FEISHU_FULL_ACCESS_AND_HANDIFF_HANDOVER.md" --profile=full "codex"
```

回执显示 full access 已成功，新 run 以 `danger-full-access` 启动：

```text
✅ 已为 lcx 启动 fresh session
请求权限：Full Access
实际落库权限：Full Access
Run：cmnly4qve00265jfg9q7v2ya7
```

Codex 收到 handover 并开始工作——但随后用户再发任何一条消息，Codex 就回报：

```text
当前权限是 workspace-write，不是 Full Access。
审批策略是 never。
git add -A --dry-run → fatal: 不能创建 .git/index.lock：只读文件系统
```

### 根因（两层，第二层才是真正的根）

#### 第一层（已在上一轮修复）

`handleNewSessionCommand` 原先在 `--profile=full` 时，没有把新的 `permissionConfig` 持久化到 `task.acpxPermissionConfig`（或仅在 profile 不同时才写）。

这导致 task 本身仍是 `safe_local`，后续 continuation 从 task 读回旧配置。

上一轮已在 `feishu.ts` 的 `handleNewSessionCommand` 中补上了写库逻辑。

#### 第二层（2026-04-06 确认，本轮修复）

即使第一层修复生效，问题依然复现。通过日志确认：

```text
[Codex] Exec args: exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral -
[Codex] Sandbox mode: danger-full-access     ← 第一条 run 是正确的

[Codex] Exec args: exec resume 019d5e5e-... --json --skip-git-repo-check -
[Codex] Sandbox mode: workspace-write        ← 第一条 resume 就已经掉回去了
[Codex] Approval policy: never
```

问题在 `src/lib/live-room.ts` 的 `syncLiveRoomSourceTask` 函数。

该函数在**每次消息到来时都会被调用**，其作用是同步 live room 对应的 backing task。但其实现中，update 分支和 create 分支共用了同一份 `taskData`，且 `taskData` 中硬编码了：

```typescript
acpxPermissionConfig: JSON.stringify(DEFAULT_ACPX_PERMISSION_CONFIG),
```

即每次消息到来时，无论 task 当前保存的是什么权限配置，`syncLiveRoomSourceTask` 都会把 `acpxPermissionConfig` **覆写回默认值** `workspace-write / never`。

时序如下：

1. `/ap new-session --profile=full` → `task.acpxPermissionConfig` 写为 `full_access` ✓
2. 用户发下一条消息 → `executeLiveRoomReplyViaAcpx` → `syncLiveRoomSourceTask`
   → `prisma.task.update({ acpxPermissionConfig: DEFAULT })` → **覆写回 `workspace-write / never`** ✗
3. 同一函数读回 `sourceTask.acpxPermissionConfig` → 得到 `workspace-write / never`
4. resume Codex，不传 `--dangerously-bypass-approvals-and-sandbox`
5. Codex 报告权限为 `workspace-write`，`.git` 不可写

### 修复

**文件：`src/lib/live-room.ts`，函数：`syncLiveRoomSourceTask`**

将原本共用的 `taskData`（含 `acpxPermissionConfig`）拆分为：

- `taskDataBase`：供 update 使用，**不包含** `acpxPermissionConfig`
- create 时额外附加 `acpxPermissionConfig: JSON.stringify(DEFAULT_ACPX_PERMISSION_CONFIG)`

关键 diff（精简）：

```diff
- const taskData = {
+ const taskDataBase = {
    name: taskName,
    description: taskDescription,
    executionMode: 'acpx',
    acpxParticipants: JSON.stringify(participants),
-   acpxPermissionConfig: JSON.stringify(DEFAULT_ACPX_PERMISSION_CONFIG),
    workingDirectory: process.cwd(),
    result: JSON.stringify({ ... }),
  };

  const sourceTask = room.sourceTask
    ? await prisma.task.update({
        where: { id: room.sourceTask.id },
-       data: taskData,
+       // acpxPermissionConfig intentionally excluded: must not reset what
+       // /ap grant or /ap new-session has stored.
+       data: taskDataBase,
        include: { currentTaskSession: true },
      })
    : await prisma.task.create({
-       data: taskData,
+       data: {
+         ...taskDataBase,
+         acpxPermissionConfig: JSON.stringify(DEFAULT_ACPX_PERMISSION_CONFIG),
+       },
        include: { currentTaskSession: true },
      });
```

修复后，update 路径不再碰 `acpxPermissionConfig`，任何由 `/ap grant` 或 `/ap new-session` 写入的权限都会被保留。

## 已确认可用的能力

### A. 文本授权链路可用

当前已确认：

- Feishu 中执行 `/ap grant full --agent=...` 可以成功返回"已授予完全权限"的回执。
- 说明 platform / ACPX 侧的 full access continuation 逻辑已经打通。

### A2. new-session 显式 full access 已接入

当前已确认代码路径：

- `/ap new-session` 不再只能被动沿用旧 task 权限
- 现在可以直接在 Feishu 命令里指定：

```text
/ap new-session --handover="docs/65_FEISHU_FULL_ACCESS_AND_HANDIFF_HANDOVER.md" --profile=full "codex"
```

执行后，本次 fresh session 会：

- 先读取 handover
- 再以新的 session 继续执行
- 且这次启动会带上 `full_access` 权限配置

### B. 授权卡片可以发出

当前已确认：

- Feishu 中可以看到 `/ap rights --agent=codex` 发送出的按钮卡片。

## 遗留问题

### 1. 卡片按钮目前依赖浏览器可访问 `AGENT_PLATFORM_BASE_URL`

现状：

- 当前 `.env` 中已将：
  - `AGENT_PLATFORM_BASE_URL=http://10.0.8.4:3010`
- 用户点击卡片按钮后，Feishu 客户端尝试打开类似：
  - `http://10.0.8.4:3010/api/feishu/grant?token=...`

实际问题：

- 用户侧点击后报错 `ERR_TIMED_OUT`
- 说明 Feishu 客户端所在设备到 `10.0.8.4:3010` 网络不通
- 这不是 ACPX 授权逻辑本身失败，而是"按钮跳转 URL 对客户端不可达"

结论：

- 文本命令 `/ap grant full --agent=...` 可用
- 按钮卡片"可见"，但点击后是否可用取决于客户端网络可达性

### 2. 更理想的下一步：改成 Feishu 原生卡片回调，不再依赖浏览器打开页面

已确认信息：

- 本地依赖 `@larksuiteoapi/node-sdk` 中存在 `CardActionHandler`

说明：

- 后续可以把卡片按钮从 `url` 跳转改成 `value` 回调
- 这样点击按钮后，动作可以直接回到平台处理，不再依赖 `AGENT_PLATFORM_BASE_URL` 对客户端可达

本轮没有继续做这一步，原因是先把"能授权"和"能继续原 session"这条主链路打通，并验证文本命令可用。

## 当前工作树状态

本轮关注到的工作树状态如下：

- 已修改：
  - `.env`（本地配置，不提交）
  - `src/lib/feishu-api.ts`
  - `src/lib/feishu.ts`
  - `src/lib/live-room.ts`（2026-04-06 新增修复）
- 新增：
  - `src/lib/feishu-grant.ts`
  - `src/app/api/feishu/grant/route.ts`
- 不建议提交：
  - `prisma/dev.db`
  - `logs/`
  - `nohup.out`

## 关于 commit 的重要说明

### 本次 new session 的任务：验证 full access 并提交

这是首个使用 `--profile=full` + 修复后代码的新 session，任务是：

1. **先验证自己当前确实有 `.git` 写权限**：
   - 执行 `git status`，确认能正常读取
   - 执行 `git add --dry-run src/lib/live-room.ts`，确认不报"只读文件系统"
   - 如果报错，说明 `syncLiveRoomSourceTask` 修复未生效（可能 runtime 未重启），立即停止，告知用户

2. **验证通过后，精确 staging 并提交**：

应纳入本轮提交的文件：

```
src/lib/feishu.ts
src/lib/feishu-api.ts
src/lib/feishu-grant.ts
src/lib/live-room.ts
src/app/api/feishu/grant/route.ts
docs/65_FEISHU_FULL_ACCESS_AND_HANDIFF_HANDOVER.md
```

不能提交的文件：

```
.env
prisma/dev.db
logs/
nohup.out
```

3. **提交信息建议**：

```
feat: Feishu full access grant, new-session profile, and fix permission reset bug

- Add /ap grant <dev|full> and /ap rights Feishu commands
- Add /ap new-session --profile=<safe|dev|full> explicit permission tier
- Add sendFeishuInteractiveMessage for card-based grant flow
- Fix: syncLiveRoomSourceTask was overwriting acpxPermissionConfig with
  DEFAULT on every message delivery, causing full-access sessions to drop
  back to workspace-write on first continuation

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## 可参考的测试命令

Feishu 中可测试：

```text
/ap grant full --agent=codex
/ap rights --agent=codex
/ap new-session --handover="docs/65_FEISHU_FULL_ACCESS_AND_HANDIFF_HANDOVER.md" --profile=full "codex"
```

其中：

- 前者已经确认能成功授权并 continuation
- 第二条当前能发卡，但按钮点击是否成功取决于客户端能否访问 `AGENT_PLATFORM_BASE_URL`
- 第三条是现在推荐给用户直接开的 fresh session 命令，且会显式请求 full access

## handover 文档命名规则

这条要明确传递给下一位 agent：

- handover 文档应优先使用带编号的文档名：
  - `docs/65_FEISHU_FULL_ACCESS_AND_HANDIFF_HANDOVER.md`
- 不要只依赖日期式自动命名
- 如果后续继续写新的 handover，应按已有编号序列递增（66、67……），保持可追踪性

## 一句话总结

本轮完整打通了 **Feishu 文本授权 full access** 和 **new-session 显式指定 full access** 两条主链路；  
并修复了关键根因 bug：**`syncLiveRoomSourceTask` 在每次消息到来时都会把 `task.acpxPermissionConfig` 覆写回默认值**，导致后续所有 continuation 掉回 `workspace-write`。  
当前工作区代码已包含所有修复；下一位 agent（本次 new session）的首要任务是：**验证自己确实有 `.git` 写权限，然后完成精确 staging 并提交。**
