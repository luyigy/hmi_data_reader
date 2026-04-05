# 65 Feishu Full Access 与交接说明

## 日期

2026-04-05

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

## 已确认可用的能力

### A. 文本授权链路可用

当前已确认：

- Feishu 中执行 `/ap grant full --agent=...` 可以成功返回“已授予完全权限”的回执。
- 说明 platform / ACPX 侧的 full access continuation 逻辑已经打通。

### A2. new-session 显式 full access 已接入

当前已确认代码路径：

- `/ap new-session` 不再只能被动沿用旧 task 权限
- 现在可以直接在 Feishu 命令里指定：

```text
/ap new-session --handover="docs/65_FEISHU_FULL_ACCESS_AND_HANDOFF_HANDOVER.md" --profile=full "codex"
```

执行后，本次 fresh session 会：

- 先读取 handover
- 再以新的 session 继续执行
- 且这次启动会带上 `full_access` 权限配置

### B. 授权卡片可以发出

当前已确认：

- Feishu 中可以看到 `/ap rights --agent=codex` 发送出的按钮卡片。

## 当前遗留问题

### 0. 新发现的关键问题：fresh session 的 full access 没有持久化到 task，后续 continuation 会掉回 safe_local

这是本轮后半段确认出来的真实根因，必须放到最前面。

已确认的事实链如下：

1. 用户在 Feishu 中执行：

```text
/ap new-session --handover="docs/65_FEISHU_FULL_ACCESS_AND_HANDOFF_HANDOVER.md" --profile=full "codex"
```

2. Feishu 回执已经能明确显示：

```text
✅ 已为 lcx 启动 fresh session
Handover：docs/65_FEISHU_FULL_ACCESS_AND_HANDOFF_HANDOVER.md
请求权限：Full Access
实际落库权限：Full Access
Run：cmnlxmnf1000593iyycz3ulj3
说明：本次会以新 session 先读取 handover，再继续执行。
```

3. 对应 run `cmnlxmnf1000593iyycz3ulj3` 在 `TaskRun.controlMetadata` 中也确实记录为：

- `profile: full_access`
- `sandboxMode: danger-full-access`
- `approvalPolicy: on-request`

4. 但用户随后继续在 Feishu 中对同一 agent 说话时，运行日志显示恢复 thread 的命令却是：

```text
exec resume 019d5e51-47da-7903-9dc5-03a9f7f339b1 --json --skip-git-repo-check -
Sandbox mode: workspace-write
Approval policy: never
```

5. 同时数据库中该 task 当前保存的 `acpxPermissionConfig` 仍然是：

```json
{"profile":"safe_local","sandboxMode":"workspace-write","networkAccess":"restricted","approvalPolicy":"never","writableRoots":[]}
```

结论：

- `/ap new-session --profile=full` 已经能让“首个 fresh run”以 `full_access` 启动。
- 但在这次新增证据出现之前，`handleNewSessionCommand(...)` 没有把这次请求的权限回写到 `task.acpxPermissionConfig`。
- 因此后续 live-room 消息转发链路在 continuation / resume 时，仍会从 task 上读取旧的 `safe_local`，导致权限再次降级。

影响：

- 用户看到的 new-session 回执可能已经是 `Full Access`
- 但只要继续通过 live-room 常规消息链路和这个 agent 对话，后续 continuation 仍可能退回 `workspace-write`
- 于是用户会看到一个表面自相矛盾的现象：
  - fresh run 启动日志是 `danger-full-access`
  - 但后续 agent 自己又报告“当前不是 full access，不能 commit”

本轮已补的修复：

- 在 `src/lib/feishu.ts` 的 `handleNewSessionCommand(...)` 中新增了持久化逻辑：
  - 当用户显式指定 `--profile=...`
  - 且生成出的 `permissionConfig` 与当前 task 保存的配置不同
  - 就立刻执行 `prisma.task.update({ acpxPermissionConfig: JSON.stringify(permissionConfig) })`

这意味着：

- 代码层面已经补上“fresh run 权限”和“task 持久权限”之间的断链
- 但必须确保 Feishu runtime 重启并加载到这版代码，之后重新测试才能验证生效

当前状态：

- 这份 handover 所在工作区里已经有修复代码
- 但用户刚才验证的那一轮 `cmnlxmnf1000593iyycz3ulj3` 发生在 task 持久化修复生效前，所以 task 上仍是 `safe_local`

下一轮必须重点验证：

1. 重启 Feishu runtime 到最新代码
2. 再次执行 `/ap new-session --profile=full ...`
3. 紧接着发一条普通 Feishu 对话消息给同一 agent
4. 检查后续 continuation 日志是否仍会回落到：
   - `workspace-write`
   - `approvalPolicy: never`

如果仍回落，则说明除了 `task.acpxPermissionConfig` 持久化之外，还存在第二个降权入口；  
如果不再回落，则说明这次新增修复已覆盖核心问题。

### 1. 卡片按钮目前依赖浏览器可访问 `AGENT_PLATFORM_BASE_URL`

现状：

- 当前 `.env` 中已将：
  - `AGENT_PLATFORM_BASE_URL=http://10.0.8.4:3010`
- 用户点击卡片按钮后，Feishu 客户端尝试打开类似：
  - `http://10.0.8.4:3010/api/feishu/grant?token=...`

实际问题：

- 用户侧点击后报错 `ERR_TIMED_OUT`
- 说明 Feishu 客户端所在设备到 `10.0.8.4:3010` 网络不通
- 这不是 ACPX 授权逻辑本身失败，而是“按钮跳转 URL 对客户端不可达”

结论：

- 文本命令 `/ap grant full --agent=...` 可用
- 按钮卡片“可见”，但点击后是否可用取决于客户端网络可达性

### 2. 更理想的下一步：改成 Feishu 原生卡片回调，不再依赖浏览器打开页面

已确认信息：

- 本地依赖 `@larksuiteoapi/node-sdk` 中存在 `CardActionHandler`

说明：

- 后续可以把卡片按钮从 `url` 跳转改成 `value` 回调
- 这样点击按钮后，动作可以直接回到平台处理，不再依赖 `AGENT_PLATFORM_BASE_URL` 对客户端可达

本轮没有继续做这一步，原因是先把“能授权”和“能继续原 session”这条主链路打通，并验证文本命令可用。

### 3. 当前终端会话仍然不是 full access

这一点必须继续强调：

- 当前这个直接和用户对话的 Codex 终端会话，仍然不能写 `.git`
- 已实际验证 `git add` / `git commit` 会因 `.git/index.lock` 无法创建而失败
- 这不是 `/ap new-session --profile=full` 代码没接上
- 而是当前会话本身不是那个新拉起的 ACPX session

补充最新验证：

- 即使在当前这个 Codex 终端里直接执行：

```text
git commit --dry-run -m "checkpoint: feishu full access handover"
```

仍然会得到：

```text
fatal: 不能创建 '/data1/code/agent-platform-v2/.git/index.lock'：只读文件系统
```

所以这条会话依旧不能代替真正获得 `.git` 写权限的 full-access ACPX session 去完成提交。

## 当前工作树状态

本轮关注到的工作树状态如下：

- 已修改：
  - `.env`
  - `src/lib/feishu-api.ts`
  - `src/lib/feishu.ts`
- 新增：
  - `src/lib/feishu-grant.ts`
  - `src/app/api/feishu/grant/route.ts`
- 另外还有与本轮不完全相关或不建议直接提交的内容：
  - `docs/GIT_ADD_TEST.md`
  - `prisma/dev.db`
  - `logs/`
  - `nohup.out`

## 关于 commit 的重要说明

### 当前这个终端/Codex 会话不能负责提交 Git

必须明确写清楚：

- 当前这个“和用户直接对话的终端窗口 session”不是 Feishu 里已经被授予 full access 的 ACPX agent session。
- 之前已验证过：当前这个窗口里的会话对 `.git` 写入受限，执行 `git add` 时出现过：

```text
fatal: cannot create '/data1/code/agent-platform-v2/.git/index.lock': read-only file system
```

这说明：

- Feishu 里授予给 `lcx` / `codex` 的 `full_access`，不会自动回流到当前这个终端会话
- 所以本会话不应承担最终 `git add` / `git commit`

建议：

- 由用户在 Feishu 中新开一个已经继承 full access 的 ACPX new session
- 让下一个 agent 在那条 session 中完成：
  - 检查 diff
  - 精确 staging
  - commit

## 建议下一位 agent 的操作顺序

### 1. 先确认目标是“提交代码”，不是继续修改功能

如果用户当前主要诉求是提交本轮已完成工作，则优先做提交整理，而不是继续扩展功能。

### 2. 提交前先检查并筛掉不该提交的内容

重点注意：

- `.env` 是本地环境文件，且当前包含本地 Feishu 配置，不建议直接提交
- `prisma/dev.db` 不建议混入
- `logs/` 与 `nohup.out` 不建议提交
- `docs/GIT_ADD_TEST.md` 是否保留需看用户意图，默认也不建议随本轮功能提交

### 3. 预计应纳入本轮提交的核心代码文件

建议优先考虑这几个：

- `src/lib/feishu.ts`
- `src/lib/feishu-api.ts`
- `src/lib/feishu-grant.ts`
- `src/app/api/feishu/grant/route.ts`
- 本 handover 文档（如用户希望保留）

### 4. 提交后建议给用户说明

建议在提交说明中明确：

- 文本授权命令已可用
- 卡片按钮目前依赖浏览器打开平台 URL
- 如需彻底避免客户端网络可达性问题，后续应接入 Feishu 原生卡片回调

### 5. handover 文档命名规则

这条要明确传递给下一位 agent：

- handover 文档应优先使用带编号的文档名：
  - `docs/65_FEISHU_FULL_ACCESS_AND_HANDOFF_HANDOVER.md`
- 不要只依赖日期式自动命名：
  - 例如 `docs/20260405_xxx_HANDOVER.md`
- 如果后续继续写新的 handover，应按已有编号序列递增，保持可追踪性

## 可参考的测试命令

Feishu 中可测试：

```text
/ap grant full --agent=codex
/ap rights --agent=codex
/ap new-session --handover="docs/65_FEISHU_FULL_ACCESS_AND_HANDOFF_HANDOVER.md" --profile=full "codex"
```

其中：

- 前者已经确认能成功授权并 continuation
- 第二条当前能发卡，但按钮点击是否成功取决于客户端能否访问 `AGENT_PLATFORM_BASE_URL`
- 第三条是现在推荐给用户直接开的 fresh session 命令，且会显式请求 full access

## 一句话总结

本轮已经把 **Feishu 文本授权 full access**、**new-session 显式指定 full access** 这两条主链路接上，也确认了 fresh run 本身确实能以 `danger-full-access` 启动；  
但新发现的关键 bug 是：**new-session 的 full access 在旧实现里没有持久化回 task，因此后续 continuation 会掉回 `safe_local`**。  
当前工作区里已经补上这段持久化修复；下一位 agent 的首要任务应是：**重启 Feishu runtime，重新验证“fresh run + 后续 continuation”是否都保持 full access，并在真正具备 `.git` 写权限的 session 中完成精确 staging 和 commit。**
