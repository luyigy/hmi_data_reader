# 32 ACPX 通过 WireGuard 直连远端 Harness 方案交接

## 日期
2026-03-25

## 本轮已完成实现补充

本轮除了远端 WireGuard / Remote SSH harness 相关工作，还顺手补齐了两块明显缺失的基础管理能力。

### 1. Remote SSH Host 现在已经支持编辑与删除

已完成：
- `Remote SSH Host` 编辑
- `Remote SSH Host` 删除
- 编辑时可修改：
  - `label`
  - `host`
  - `port`
  - `sshUser`
  - `workingDirectory`
  - `viaNetwork`
  - `supportedHarnesses`
  - `privateKey`（留空表示保留原值）

实现位置：
- `src/app/api/remote-harness-hosts/[id]/route.ts`
- `src/app/remote-ssh-tools/page.tsx`

补充约束：
- 如果 `supportedHarnesses` 包含 `codex`
- 且 `sshUser = root`
- 平台会拒绝保存

原因：
- Codex 会拒绝在 `root/sudo` 身份下使用危险权限跳过参数

### 2. Live Room 现在已经支持编辑与“归档”

已完成：
- `Live Room` 编辑房间设置
- `Live Room` 归档

当前可编辑字段：
- `title`
- `description`
- `mode`

当前 topic 仍保留原先独立入口：
- `保存 Topic`

实现位置：
- `src/app/api/live-rooms/[id]/route.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`

## “归档房间”是什么意思

### 不是物理删除，而是软删除

当前 `归档房间` 的真实语义是：
- 把 `LiveRoom.status` 从 `active` 改成 `archived`
- 房间从当前左侧 active rooms 列表中隐藏
- 关联消息、成员、delivery、session 数据不会被物理删除

也就是说它更接近：
- archive
- soft delete

而不是：
- hard delete

### 为什么这版先做归档而不是直接硬删除

主要原因有三个：

1. 更安全
- 房间里已经可能积累：
  - transcript
  - delivery records
  - speaker 状态
  - room members
- 如果一上来直接硬删除，误操作成本太高

2. 更符合当前 schema
- 现有 `LiveRoom.status` 已经有：
  - `active`
  - `archived`

这说明数据模型本身就已经预留了 archive 语义。

3. 更适合当前产品阶段
- 现在 live room 还在快速试错
- 很多时候用户只是想：
  - 先把旧房间藏起来
  - 不让左侧列表继续堆积
- 并不一定真的要永久抹掉所有历史

## 归档和删除是不是一回事

短答案：
- 不是一回事

更准确地说：

### 归档
- 从当前活跃列表消失
- 数据保留
- 可用于后续恢复、审计、排查
- 风险低

### 硬删除
- 物理删除 `LiveRoom`
- 并连带删除其关联数据
- 不可恢复
- 风险高

## 当前能不能做真正删除

能做，而且现在已经补上了。

### 当前最终语义

平台现在支持两段式房间移除：

1. `Archive`
- 把房间标记为 `archived`
- 从左侧 active 列表隐藏
- 保留全部历史数据

2. `Delete permanently`
- 仅允许对 `archived` 房间执行
- 物理删除 `LiveRoom`
- 并级联删除其成员、消息、session、delivery 等关联数据

### 为什么要先归档再永久删除

这是一个刻意保留的安全护栏：
- 避免误删
- 让“隐藏房间”和“抹掉数据”分成两个动作
- 符合当前 live room 仍在频繁试验的使用阶段

也就是说：
- 不是一键直接 hard delete
- 而是先 archive，再 hard delete

## 左侧房间列表能不能直接有编辑/删除按钮

可以，而且工作量不大。

但这里有一个典型 UI 细节要注意：
- 左侧列表项当前本质是一个整块可点击跳转的 link
- 如果直接在整块 link 上再塞“编辑 / 删除”按钮
- 很容易出现：
  - 点按钮时同时触发跳转
  - hover 区域拥挤
  - 移动端误触

### 我建议的做法

不要直接堆两个常驻大按钮，
而是做成更轻的列表级操作：

方案 A：
- 每个房间条目右上角放一个 `...` 操作菜单
- 菜单里放：
  - `Edit`
  - `Archive`
  - 以后如需要再加 `Delete permanently`

方案 B：
- 房间 hover 时显示两个小 icon button
- 但要把按钮从 link 点击区域里拆出来

我更推荐：
- 方案 A，三点菜单

原因：
- 更稳
- 更不容易误触
- 后续扩展动作更方便

## 左侧列表按钮这件事的工作量判断

不重。

如果只加：
- 左侧 `Edit`
- 左侧 `Archive`

基本属于：
- 小到中等工作量

主要改动会在：
- `src/components/live-room/LiveRoomWorkspace.tsx`

核心不是数据层难，
而是：
- 交互层要避免和现有 link 跳转冲突

## 如果后续要继续补，我建议的顺序

1. 左侧列表增加 `...` 菜单
2. 菜单接已有 `Edit room settings`
3. 菜单接已有 `Archive room`
4. 如确实需要，再继续增强：
   - archived rooms 专门列表
   - 便于二次进入后再执行 `Delete permanently`
   - 或做 restore / unarchive

## 追加进展：左侧房间列表 `...` 菜单已实现

在这一轮后，左侧 live room 列表已经不再只是纯跳转入口，
而是补上了每个房间的轻量操作菜单。

### 已实现
- 每个房间条目右侧新增 `...` 菜单
- 菜单内已接入：
  - `Edit`
  - `Archive`

### 当前交互语义

`Edit`
- 跳转/定位到该房间
- 自动打开右侧 details panel
- 使用已有的 room settings 编辑能力

`Archive`
- 直接对该房间执行归档
- 若归档的是当前正在查看的房间：
  - 当前详情页仍可停留
  - 左侧 active 列表会隐藏该房间
  - 这时右侧 panel 会出现 `永久删除`

`Delete permanently`
- 当前放在右侧房间 settings 区
- 仅当房间状态已经是 `archived` 时显示
- 会做不可恢复的物理删除

### 为什么这样实现

这样可以避免把：
- 行点击跳转
- 编辑按钮
- 删除/归档按钮

全部塞进同一个可点击 link 区域里，
从而减少误触和事件冲突。

### 对应实现位置
- `src/components/live-room/LiveRoomWorkspace.tsx`

## 追加进展：永久删除已实现

在这一轮后，live room 已经具备完整的两段式移除能力：
- `Archive`
- `Delete permanently`

### 后端语义

当前 `src/app/api/live-rooms/[id]/route.ts` 的行为是：

- `PATCH`
  - 可更新：
    - `title`
    - `description`
    - `mode`
    - `status`

- `DELETE`
  - 默认语义：
    - 归档房间
  - 当携带 `?hard=true` 时：
    - 仅允许删除已归档房间
    - 执行真正物理删除

### 前端语义

- 左侧列表：
  - `... -> Archive`

- 右侧房间 settings：
  - active 房间显示：
    - `保存房间设置`
    - `归档房间`
  - archived 房间额外显示：
    - `永久删除`

## 追加进展：archived rooms 现在可见了

之前会出现一个很真实的产品问题：
- 房间归档后
- 左侧列表里完全看不到
- 用户会以为：
  - 归档失败了
  - 或者房间被直接删掉了

根因很直接：
- 旧版 `GET /api/live-rooms`
- 只返回 `status = active`

所以用户侧观感就是：
- 一旦 archive
- 房间直接“消失”

### 现在的行为

现在左侧列表分成两层：

1. Active rooms
- 正常显示当前活跃房间

2. Archived rooms
- 作为一个可展开/收起的分组显示
- 可以再次打开 archived 房间查看详情
- archived 房间的 `...` 菜单里可执行：
  - `Edit`
  - `Delete Permanently`

### 对应实现
- `src/app/api/live-rooms/route.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`

## 追加进展：消息刷新不再主要依赖手动刷新

你这次观察到的现象是对的：
- 之前 live room 的刷新体验确实偏依赖手动 refresh

### 原因 1. socket 初始化并不稳

旧逻辑里前端会直接尝试连 socket，
但如果 socket server 还没被初始化，
连接体验会不稳定。

现在已补：
- 前端在 connect 前先请求 `/api/socket`
- 先确保 socket server ready

对应实现：
- `src/lib/websocket-client.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`

### 原因 2. 之前缺少轮询兜底

即使 socket 是主通道，
在真实环境里仍可能出现：
- socket 暂时没连上
- 事件漏掉
- 浏览器标签页切换后恢复不及时

所以现在又补了一层保守兜底：
- 页面可见时
- 每 5 秒自动刷新：
  - room list
  - 当前 room detail / messages

这样即便 socket 某一刻不工作，
也不会长期卡在旧内容上。

### 原因 3. room 状态变化之前没有统一广播

旧版更多是：
- 发消息时广播 `live-room:message`
- 发消息后广播 `live-room:updated`

但像这些动作：
- 编辑房间
- 归档房间
- 永久删除房间

之前并没有完整地走统一实时广播。

现在已补：
- room update 后广播 `live-room:updated`
- room hard delete 后广播 `live-room:deleted`

所以多个页面/tab 之间的同步也会更自然。

对应实现：
- `src/lib/live-room.ts`
- `src/app/api/live-rooms/[id]/route.ts`

## 当前这套刷新机制的最终形态

现在 live room 的刷新策略是：

1. 首选 socket 实时事件
- `live-room:message`
- `live-room:updated`
- `live-room:deleted`

2. 轮询兜底
- 页面可见时每 5 秒 refresh 一次

这样做的目标不是“最省请求”，
而是：
- 先把使用体验稳定下来
- 降低“必须手动刷新才看到变化”的概率

## 最新实测补充

在新 room 的真实执行里，远端 `codex` 出现了这个错误：

```text
系统提示：TX-server Claude 本次回复失败：
Warning: Permanently added '10.0.8.10' (ED25519) to the list of known hosts.
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

这说明问题已经不再是：
- WireGuard 不通
- SSH 不通
- 平台找不到远端主机

而是进入了更具体的一层：
- 远端 `codex` 实际运行身份是 `root`
  或
- 远端 `codex` 被包了一层 `sudo` / root wrapper

需要特别注意：
- 这不是平台 SSH transport 本身挂了
- 而是 Codex CLI 自己拒绝在 `root/sudo` 身份下使用危险权限跳过参数

因此当前远端 Codex 的硬性要求应补充为：
- `codex` 必须由非 root 用户执行
- 不要让登录 shell、alias、wrapper script 自动给 `codex` 套 `sudo`
- 远端工作目录最好归该普通用户所有

建议最小修复：
1. 在远端机器创建一个普通用户，例如 `ubuntu` / `dev` / `coder`
2. 用该用户安装并登录 `codex`
3. 把 ACPX Remote SSH host 的 `sshUser` 改成这个普通用户
4. 确保 `workingDirectory` 对该用户可读写

补充说明：
- `Warning: Permanently added ... known hosts` 这一段不是根因，可忽略
- 真正导致失败的是后半句 root/sudo 权限限制

## 背景
当前平台已经具备：
- `platform_local` 本机 CLI harness
- `gateway_openclaw` 远端 gateway / OpenClaw harness
- live room / ACPX participant / task runner 的基本执行链路

新的需求是：
- 用户通过 WireGuard 能访问一台远端服务器
- 那台服务器上已经装好了 `claude` 或 `codex`
- 用户希望把那台机器上的 harness 直接接入平台
- 不想强制依赖 OpenClaw gateway

一句话说：
用户要的是
- `remote harness over WireGuard`

而不是：
- 再套一层完整 OpenClaw 产品协议

## 当前代码里的真实边界

### 1. 当前 execution backend 只有两种
关键类型定义见：
- `src/lib/acpx/types.ts`

当前 `AcpxExecutionBackend` 只有：
- `platform_local`
- `gateway_openclaw`

这意味着：
- 平台目前没有第三种“远端但非 OpenClaw”的执行后端
- 远端 WireGuard 机器上的 `claude` 不能自然归类进现有模型

### 2. `platform_local` 的真实含义是“运行平台进程的同机本地 CLI”
关键实现见：
- `src/lib/acpx/catalog.ts`
- `src/lib/real-agents/codex-agent.ts`
- `src/lib/real-agents/claude-agent.ts`
- `src/lib/live-room-delivery.ts`

当前 `platform_local` 的逻辑本质是：
- 平台所在机器执行 `codex ...`
- 或平台所在机器执行 `claude ...`

也就是说，
它不是“任意可 SSH 到的机器上的本地 CLI”，
而是：
- same host local process execution

所以不能把 WireGuard 远端机器硬塞进 `platform_local`。

### 3. 远端执行目前只通过 `gateway_openclaw`
远端 agent 现在的稳定产品路径是：
- 数据库中有 `Gateway`
- gateway 下挂 `agents`
- 平台通过 `openclaw-client` 发请求
- 使用 `sessionKey` 做远端会话连续性

因此如果不用 OpenClaw，
当前平台实际上没有现成的远端 CLI transport。

## 结论：现在能不能直接接？

### 短答案
不能直接接。

更准确地说：
- 从产品需求上，这件事完全合理
- 但从当前代码结构上，平台还没有 `remote_ssh` / `remote_cli` 这一层
- 所以还不能只填一个 WireGuard IP 就把远端 `claude` 接进来

## 推荐的两条实现路线

## 路线 A. 继续走 gateway 思路，但做一个极薄的 adapter

### 核心想法
不一定要把远端主机变成“完整 OpenClaw 产品”，
可以只在那台远端机器上放一个很薄的 adapter service：
- 接收平台请求
- 本机执行 `claude` / `codex`
- 返回输出

然后平台侧仍把它看成：
- 一个 gateway-like remote executor

### 优点
- 最贴近当前现有架构
- 不用大改 ACPX execution backend 类型
- `live room`、`task runner`、catalog、sessionKey 这些已有链路可复用
- 后续如果要支持更多远端机器，也更统一

### 缺点
- 用户原本明确说了“不想强依赖 OpenClaw gateway”
- 即便做得很薄，本质上还是一种 gateway adapter
- 对于单机远端 Claude 接入来说，概念仍偏重

### 适用场景
适合：
- 希望尽快接通
- 接下来可能有多台远端主机
- 想复用现有 gateway 管理模型

## 路线 B. 新增第三种 backend：`remote_ssh` 或 `remote_cli`

### 核心想法
明确在 ACPX / Live Room / Task Runner 里引入新后端，例如：
- `remote_ssh`

由平台直接通过：
- WireGuard 可达 IP
- SSH
- 远端 shell

执行：
- `claude`
- `codex`

### 我更推荐的命名
我建议优先用：
- `remote_ssh`

而不是：
- `remote_cli`

因为真正的 transport 不是“抽象远端”，
而是：
- 通过 SSH 到达远端机器执行 CLI

这样后续能力边界会更清晰。

## 我对这两条路线的建议

### 如果目标是“最快接上那台远端 Claude”
推荐：
- 路线 A

也就是：
- 先做极薄 adapter
- 平台继续按 remote service 调用

### 如果目标是“产品语义更干净，未来支持多种远端 CLI 主机”
推荐：
- 路线 B

也就是：
- 正式引入 `remote_ssh`

就长期方向而言，
我更推荐路线 B。

原因是它更符合用户真正的 mental model：
- “这不是一个 gateway agent”
- “这是我网络里另一台机器上的 Claude Code / Codex”

## 为什么不建议把远端机器伪装成 `platform_local`

### 原因 1. 语义会变脏
`platform_local` 现在意味着：
- 平台进程所在机器本地执行

如果硬把远端 WireGuard 机器塞进去，
后续会出现大量混乱：
- 权限解释不准
- working directory 语义错位
- 日志里看起来像本地，其实不是本地

### 原因 2. capability 也会变脏
关键文件：
- `src/lib/acpx/capabilities.ts`

当前 capability 是按：
- backend
- harnessType

来推导的。

如果把远端 SSH CLI 伪装成 `platform_local`，
那以下能力就会产生误导：
- immediate interrupt
- live session control
- soft stop
- resume after interrupt

因为远端 SSH 的这些能力通常和本地 CLI 不完全等价。

### 原因 3. session / thread / cwd 都不是同一回事
本地 Codex 现在能做 continuation，
是因为本地 CLI 与平台在同一台机器上，
thread / cwd / permissions 逻辑相对直接。

远端 SSH CLI 则会新增：
- SSH auth
- remote cwd
- reconnect
- thread 恢复
- 进程存活
- 网络断开后的补偿

这显然不是 `platform_local` 的问题域。

## 推荐的 `remote_ssh` 领域模型

### 1. 新增 backend
建议在：
- `src/lib/acpx/types.ts`

把：
- `AcpxExecutionBackend = 'platform_local' | 'gateway_openclaw'`

扩展成：
- `platform_local | gateway_openclaw | remote_ssh`

### 2. 新增远端主机配置实体
建议新增类似实体，例如：
- `RemoteHarnessHost`
  - `id`
  - `label`
  - `host`
  - `port`
  - `sshUser`
  - `authType`
  - `privateKeyRef / encryptedPrivateKey`
  - `workingDirectory`
  - `status`
  - `viaNetwork = wireguard`

### 3. 新增远端 harness 声明
例如：
- `RemoteHarnessAgent`
  - `hostId`
  - `harnessType = claude | codex`
  - `displayName`
  - `runtimeAgentId`
  - `canResume`
  - `supportsInterrupt`
  - `supportsStreaming`

这样 catalog 层就可以像列出 gateway harness 一样列出 remote SSH harness。

## 推荐的最小实现链路

### Phase 1. 只做“单次执行”，不做连续会话
第一版不要一上来追求：
- interrupt
- resume
- streaming
- background process reattach

建议先做到：
1. 平台可配置一个远端 SSH 主机
2. 平台可声明该主机上的 `claude` / `codex`
3. 下发任务时通过 SSH 执行一次命令
4. 拿回 stdout / stderr
5. 记录为 ACPX participant / live room reply

### 为什么先这样做
因为这样能最快验证：
- WireGuard 网络连通
- 远端 CLI 可执行
- 认证能跑通
- cwd 与模型路径可见
- 平台对远端命令的包装是否稳定

## 推荐的执行方式

### Claude
平台通过 SSH 执行类似：
```bash
ssh user@wg-host 'cd /path/to/workdir && claude "..." --print --permission-mode bypassPermissions'
```

### Codex
平台通过 SSH 执行类似：
```bash
ssh user@wg-host 'cd /path/to/workdir && codex exec --json --sandbox workspace-write --skip-git-repo-check -'
```

如果要传长 prompt，
更推荐：
- stdin 管道
- 或临时文件

而不是全放在命令行参数里。

## 后续能力分层建议

### 第一层
- one-shot execution

### 第二层
- persistent session / thread continuation

### 第三层
- interrupt / stop / soft-stop

### 第四层
- full live-room parity
  例如：
  - streaming token output
  - append message
  - room member session presence

## 对 Live Room 的具体建议

如果未来接入远端 SSH harness，
在 live room 层应显示来源类似：
- `Claude Remote · WG-Linux-01 / claude`

而不是：
- `Platform Local Claude`

也不是：
- 某个 gateway 名称

这样用户能明确知道：
- 这个 agent 运行在哪台远端机器上
- 它不是本地，也不是 OpenClaw gateway

## 给下一位会话的明确结论

### 结论 1
当前平台不能直接把 WireGuard 后的远端 Claude Code 接成现有 harness，
因为 backend 模型里缺少：
- `remote_ssh`

### 结论 2
如果只是求快，
可以用极薄 adapter，继续借用 gateway 思路。

### 结论 3
如果想把产品模型做对，
更推荐新增：
- `remote_ssh` backend

### 结论 4
第一版不要贪心，
先做：
- one-shot remote execution

把网络、认证、cwd、远端 CLI 可执行性跑通后，
再补：
- resume
- interrupt
- streaming

一句话总结：
这不是“再接一个 gateway”的问题，
也不是“把远端机器伪装成本地”的问题，
而是平台需要正式支持一种新的执行后端：
- `remote_ssh harness`

## 落地 Implementation Plan

### 本轮目标
本轮直接按路线 B 落地：
- 新增 `remote_ssh` backend
- 先交付 one-shot remote execution
- 不在第一版承诺 interrupt / resume / full session parity

### Phase 1 范围
本轮实现建议收敛为以下闭环：
1. 数据层新增 `RemoteHarnessHost`
2. host 上声明可用 harness 列表（先用 JSON string array 即可）
3. catalog 把远端 SSH harness 一起列入 ACPX harness options
4. ACPX task create / runner 能识别 `remote_ssh`
5. runner 通过本机 `ssh` 命令直连远端主机
6. 远端执行 `claude` 或 `codex`
7. 回收 stdout / stderr，并写入 task run event

### Phase 1 明确不做
- 持久 session
- thread continuation
- remote process reattach
- interrupt / stop 语义承诺
- 远端 working directory 的 UI 自由输入
- live room 里的 full parity session management

### 推荐的数据模型

#### `RemoteHarnessHost`
- `id`
- `label`
- `host`
- `port`
- `sshUser`
- `authType`
- `encryptedPrivateKey`
- `workingDirectory`
- `status`
- `viaNetwork`
- `supportedHarnesses`

### 关键实现步骤

#### Step 1. 扩展 backend 类型
更新：
- `src/lib/acpx/types.ts`

把 backend 扩展为：
- `platform_local | gateway_openclaw | remote_ssh`

#### Step 2. 新增远端 host 配置模型
更新：
- `prisma/schema.prisma`
- 新 migration

说明：
- 第一版先不拆 `RemoteHarnessAgent`
- 用 `RemoteHarnessHost.supportedHarnesses` 承载 host 下可用 harness 声明
- 后续若要做每个 harness 的更细 capability，再拆独立实体

#### Step 3. catalog 纳入 remote SSH harness
更新：
- `src/lib/acpx/catalog.ts`

目标：
- 任务创建时能像选本地 / gateway harness 一样选到远端 SSH harness
- label 显示成：
  - `WG-Linux-01 / Codex SSH`
  - `WG-Linux-01 / Claude SSH`

#### Step 4. 实现最小 SSH executor
建议新增：
- `src/lib/remote-harness/ssh-executor.ts`

最小要求：
- 支持 key-based auth
- 支持 host / port / user
- 支持 remote cwd
- 支持 stdin prompt 传输
- 支持 stdout / stderr streaming callback

#### Step 5. runner 接入 `remote_ssh`
更新：
- `src/lib/acpx/runner.ts`

目标：
- `platform_local` 继续走现有本地 CLI
- `gateway_openclaw` 继续走现有 gateway client
- `remote_ssh` 走新的 SSH executor

#### Step 6. API 先补最小 host 管理入口
建议新增：
- `GET /api/remote-harness-hosts`
- `POST /api/remote-harness-hosts`

第一版即可满足：
- 写入 host 配置
- 在前端或脚本中被 catalog 消费

### 本轮验收标准
- 数据库可存一条远端 SSH host
- `/api/acpx/harness-options` 能返回 remote SSH harness
- ACPX task 可带 `remote_ssh` participant 创建成功
- runner 能通过 SSH 在远端执行一次 `claude` 或 `codex`
- stdout / stderr 能进入 run events
- capability 明确显示第一版不支持 interrupt / resume

### 下一阶段
- 为 `remote_ssh codex` 增加 thread continuation
- 定义 remote interrupt 的真实语义
- 做 remote host 连通性测试入口
- 在 task / live room UI 里更明确地区分：
  - Platform Local
  - OpenClaw Gateway
  - Remote SSH

## 当前实现状态更新

### 已完成
- 已新增 `remote_ssh` backend
- 已新增 `RemoteHarnessHost` 数据模型与最小管理 API
- 已新增 `/remote-ssh-tools` 页面，可创建 host 并做 SSH / CLI probe
- 已验证目标机可通过平台侧 SSH key 登录
- 已验证目标机上 `claude` 可通过 SSH login shell 执行：
  - `ssh ... 'bash -lc "command -v claude && claude --version"'`
- ACPX task 链路已接入 `remote_ssh`
- Live Room roster / catalog 已可展示 `Remote SSH` agent
- Live Room delivery 已补 `remote_ssh` 执行分支

### 已确认的真实运行问题

#### 问题 1. `remote_ssh` 不能写入 `LiveRoomMember.gatewayId`
原因：
- `LiveRoomMember.gatewayId` 外键指向 `Gateway`
- `RemoteHarnessHost` 不是 `Gateway`
- 因此 remote SSH member 不能把 host id 直接放进 `gatewayId`

这个问题已经在代码里修过：
- `gateway_openclaw` member 才写 `gatewayId`
- `remote_ssh` member 改为不写该字段

#### 问题 2. Live Room reply 时仍可能报：
- `Remote SSH member missing host id`

原因：
- 为绕过外键，`remote_ssh` member 的 `gatewayId` 变成了 `null`
- 后续 reply 仍需要拿到 remote host id 才能 SSH 执行
- 当前已改为把 remote host ref 编码到 member 的持久化字段里，再在 delivery 时解出

### 截至本次会话的最新现场现象
用户在 Live Room 内测试：
- 选中 `TX-server Claude`
- 发送：
  - `@TX-server Claude hello`

系统仍返回：
- `系统提示：TX-server Claude 本次回复失败：Remote SSH member missing host id`

这说明：
- 最新修复代码尚未真正作用到当前被测试的 room member
- 或当前房间里的该 member 是旧数据，在修复前创建，未携带 remote host ref
- 或 3010 上的运行进程尚未加载到最新代码

## 下一位会话建议的第一优先级排查

### 优先判断是否是“旧 room / 旧 member 数据”
最先验证：
1. 重启 3010 上的 Next 服务
2. 不复用旧 room
3. 新建一个全新的 Live Room
4. 重新把 `TX-server Claude` 加入新 room
5. 再测试一次

原因：
- 当前报错非常像旧 member 记录未带上新的 remote host ref
- 如果继续在旧 room 上测，可能一直命中旧数据

### 如果新 room 仍复现
下一步应直接检查数据库中的 `LiveRoomMember`
关注字段：
- `backend`
- `gatewayId`
- `roleLabel`
- `runtimeAgentId`
- `displayName`

重点确认：
- `backend = remote_ssh`
- `roleLabel` 内是否已带 remote host ref

### 若数据库里 `roleLabel` 未带 remote host ref
则说明：
- 创建 room / add member 路径运行的仍不是最新代码
- 或前端选中的 agent 数据与后端实际入库数据不一致

## 当前可给用户的操作建议
- 不要继续复用当前出错的旧 room
- 重启 3010 服务后，新建一个全新的 room 再测
- 若仍失败，抓取该 room 对应的 `LiveRoomMember` 行内容继续排查
