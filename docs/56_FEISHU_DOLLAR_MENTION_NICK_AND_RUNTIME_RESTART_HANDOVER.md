# 56 Feishu `$mention`、房间昵称命令与运行时重启交接文档

## 日期
2026-04-04

---

## 一、背景

本轮主要处理的是 Feishu Live Room 在实际使用中的三类问题：

1. **Feishu 中点名不稳定**
   用户在飞书里点了某个成员，例如 `hk-vision Claude`，结果消息仍可能路由到错误成员。

2. **飞书原生 `@` 干扰严重**
   在 Feishu 群里输入 `@xxx` 时，经常先触发飞书自己的机器人/原生艾特能力，影响系统内部的 mention 解析。

3. **多个同名 Claude 无法管理**
   房间里有多个 `claude`，用户不知道该叫谁，也无法直接在飞书里通过 `/ap` 命令给房间成员改昵称或按昵称踢人。

---

## 二、本轮完成的功能改动

### 1. Feishu 结构化 mention 不再丢失

之前 Feishu webhook / 长连接虽然能收到 `message.mentions`，但 relay 到 Live Room 时没有真正用这份结构化信息，而是只靠文本内容做别名匹配。

这会导致：

- 用户在飞书里实际点选了某个成员
- 系统却只拿消息文本做模糊匹配
- 最终命中错误成员

本轮已修复为：

- `src/lib/feishu.ts`
  - 解析并保留 `mentionNames`
- `src/lib/feishu-long-connection.ts`
  - 长连接模式同样保留 `mentionNames`
- `src/app/api/feishu/webhook/route.ts`
  - 将 `mentionNames` 透传给 Live Room
- `src/lib/feishu-live-room.ts`
  - 优先使用 Feishu 结构化 mention 名称做精确匹配
  - 只有在没有结构化命中的情况下，才回退到原有文本别名匹配

结论：现在在 Feishu 中“点中谁”会优先按 Feishu 结构化 mention 路由，不再只靠整段文本猜。

---

### 2. 显式 mention 语法新增 `$name`

为了绕过飞书原生 `@` 干扰，本轮新增了 **`$name` 显式 mention**，并保留 `@name` 向后兼容。

涉及文件：

- `src/lib/live-room.ts`
  - 显式 mention 匹配从仅支持 `@alias` 扩展为同时支持 `@alias` / `$alias`
  - 正文剥离逻辑支持 `$alias`
  - 修复 `$claude, hello` 这类场景，剥离时会连同逗号一起处理，不再把 `, hello` 留给 agent

结论：飞书里以后建议统一使用：

```text
$hk-vision 你看一下
$local-claude 能听到吗
```

不要再依赖飞书原生 `@成员`。

---

### 3. 广播语法新增 `$all`

之前广播只支持 `@all`，在飞书群里容易与原生艾特机器人冲突。

本轮已改为：

- 后端支持 `@all` 和 `$all`
- 前端展示文案统一改向 `$all`

涉及文件：

- `src/lib/live-room.ts`
- `src/lib/live-room-delivery.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`

建议用户以后在飞书里使用：

```text
$all 大家都先打个招呼
```

---

### 4. 新增房间级 `/ap nick`

此前系统虽支持通过 UI / API 改昵称，但**没有飞书 `/ap` 命令入口**。

本轮新增房间级命令：

```text
/ap nick --member=<memberName|idSuffix> --name=<newNickname>
```

作用：

- 只修改当前 Feishu 绑定 room 内该成员的 `userNickname` / `shortAlias`
- 不改全局 Agent 名称

实现位置：

- `src/lib/feishu.ts`

支持的成员定位方式：

- 成员显示名，例如 `hk-vision Claude`
- 成员房间昵称，例如 `occ`
- 成员短别名
- 成员 ID 后 8 位，例如 `usfv2l3g`
- 成员列表原样复制格式，例如 `claude [usfv2l3g]`

推荐用法：

```text
/ap members
/ap nick --member=usfv2l3g --name=occ
```

改完之后就可以直接：

```text
$occ 你能听到吗
```

---

### 5. `/ap kick` 现在支持按昵称踢人

之前 `/ap kick` 只按原始 `displayName` 查成员，不认房间昵称，导致：

- `/ap nick ...` 改名成功
- `/ap kick occ` 却仍然提示找不到成员

本轮已修复：

- `/ap kick` 现在同时支持
  - 房间昵称
  - `shortAlias`
  - 原始名字
  - `name [idSuffix]`
  - `idSuffix`

同时错误提示里的“当前可踢出的成员”也优先显示昵称，不再总是只显示原始名。

实现位置：

- `src/lib/feishu.ts`

---

## 三、命令使用说明

### 1. 查看当前房间成员

```text
/ap members
```

输出示例：

```text
Live Room 成员列表 (xxxx)
- codex [sr2710we] | platform_local | idle
- hk-vision Claude [dvwq7yxd] | remote_ssh | idle
- claude [usfv2l3g] | gateway_openclaw | idle
```

---

### 2. 给某个成员设置房间昵称

推荐使用 ID 后缀，最稳：

```text
/ap nick --member=usfv2l3g --name=occ
```

也支持：

```text
/ap nick --member="claude [usfv2l3g]" --name=occ
/ap nick --member="hk-vision Claude" --name=hk-vision
```

---

### 3. 按昵称踢人

```text
/ap kick occ
```

如果担心歧义，用 ID 后缀：

```text
/ap kick usfv2l3g
```

---

### 4. 在飞书里定向找某个成员

```text
$hk-vision 你看一下
$occ 能听到吗
```

---

### 5. 广播给所有可回复成员

```text
$all 大家都先打个招呼
```

---

## 四、服务重启结论

### 1. 为什么经常改完以后飞书里“不生效”

本项目当前 `.env` 配置为：

```text
FEISHU_CONNECTION_MODE=long_connection
```

因此 Feishu 收消息走的是独立的长连接 runtime，而不是只靠 Next dev server 热更新。

结论：

- 修改了 `src/lib/feishu*.ts`、`src/lib/live-room*.ts` 后
- **必须重启 `npm run feishu:runtime`**
- 否则飞书仍在跑旧逻辑

这也是本轮多次出现“代码改了但 `$mention` 还不生效”的根本原因。

---

### 2. 重启方式

参考：

- `docs/52_SERVICE_BACKGROUND_RUN_HANDOVER.md`
- `docs/54_REMOTE_SSH_DUPLICATE_MEMBER_FIX_AND_SERVICE_RESTART_HANDOVER.md`

建议流程：

```bash
cd /data1/code/agent-platform-v2

# Next dev：按端口杀
pids=$(lsof -ti:3010)
[ -n "$pids" ] && kill $pids

# Feishu runtime：按进程特征杀
pkill -f feishu-standalone-monitor 2>/dev/null
sleep 2

nohup npm run dev > logs/dev.log 2>&1 &
nohup npm run feishu:runtime > logs/feishu.log 2>&1 &
```

---

### 3. 为什么 Next dev 不建议按进程名杀

本轮排查时发现：

- `next dev`
- `node_modules/.bin/next`
- `node`
- 外层 shell

这些名字都可能变化，按进程名匹配不稳定。

因此对 Next 主服务更稳的做法是：

```bash
lsof -ti:3010
```

按 **端口** 找 PID，再 kill。

Feishu runtime 没固定端口，所以仍然适合按进程特征：

```bash
ps aux | grep feishu-standalone | grep -v grep
```

---

## 五、注意事项

1. 本轮新增的 `/ap nick` 和增强后的 `/ap kick` 都在 `src/lib/feishu.ts`，改完后一定要重启 `feishu:runtime`
2. `$mention` / `$all` 已在后端支持，但如果想让 Web UI 也同步显示新文案，则需要重启 `npm run dev`
3. 当房间里存在多个同名 `claude` 时，推荐始终使用：
   - `/ap members`
   - 然后按 `id 后 8 位` 改名或踢人
4. 飞书命令里不要再额外套一层 `$lcx,` 去包 `/ap ...`，直接发送 `/ap nick ...` 或 `/ap kick ...` 即可

---

## 六、涉及文件

- `src/lib/feishu.ts`
- `src/lib/feishu-live-room.ts`
- `src/lib/feishu-long-connection.ts`
- `src/app/api/feishu/webhook/route.ts`
- `src/lib/live-room.ts`
- `src/lib/live-room-delivery.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`

---

## 七、建议的后续工作

1. 给 `/ap members` 增加更明确的“昵称 / 原始名 / idSuffix”三列输出，减少用户复制时歧义
2. 给 `/ap nick` 增加清空昵称能力，例如：

```text
/ap nick --member=usfv2l3g --name=""
```

3. 给 `/ap kick` / `/ap nick` 增加“多候选歧义提示”，当 `claude` 命中多个人时直接要求用户改用 `idSuffix`
4. 后续可考虑把 Feishu 命令统一做成：
   - `$name ...`
   - `$all ...`
   - `/ap nick ...`
   - `/ap kick ...`

形成更稳定的一套群内协作语法
