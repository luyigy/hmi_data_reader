# 66. FEISHU_MESSAGE_PARSE_AND_IMAGE_NEXT_HANDOVER

## 日期

2026-04-07

## 本轮目标

本轮主要处理了三类问题：

1. Feishu 群聊中 `@机器人 /ap ...` 的命令有时会被解析失败
2. `$lcc` / `$lcx` 这类显式点名在中文标点场景下路由不稳定
3. Feishu 的图片/富文本/文件等非纯文本消息在解析层直接被丢弃

同时，补充处理了本地 Claude 在 Feishu runtime 下与代理相关的差异。

## 已完成的修复

### 1. Feishu 群聊 `@机器人 /ap ...` 命令解析修复

文件：

- `src/lib/feishu.ts`

问题：

- 飞书群聊里带 `@` 的命令，实际收到的文本可能形如 `@_user_1 /ap help`
- 旧逻辑只会去掉 `<at ...>...</at>` 这种 XML 风格 mention
- 导致群聊命令被当成非命令忽略

修复：

- `stripBotMention(...)` 额外支持清理前缀式 `@_user_x`

结果：

- `@机器人 /ap help`
- `@机器人 /ap room ...`

这类命令现在可以进入正常命令解析流程。

### 2. `$lcc` / `$lcx` 在中文标点下的显式 mention 修复

文件：

- `src/lib/live-room.ts`

问题：

- 旧 mention 边界只支持英文标点
- 例如 `$lcc，你能听到吗？` 中的中文逗号 `，` 不被识别为合法边界
- 导致显式点名失效，消息退回默认 speaker 路由

修复：

- 扩展 mention 边界字符集，加入：
  - `，。；：！？`
  - `（）《》【】、`

结果：

- `$lcc，你能听到吗？`
- `$lcx，继续处理`

这类消息可以命中目标成员。

### 3. Feishu 群消息误把正文中的 `claude` / `codex` 当成点名

文件：

- `src/lib/live-room.ts`
- `src/lib/feishu-live-room.ts`

问题：

- 旧逻辑会在 Feishu 消息里同时使用“显式提及匹配”和“正文普通文本匹配”
- 用户只要在正文里提到 `claude`，即使不是点名，也可能被路由到 Claude
- 典型场景是用户粘贴系统错误：
  - `系统提示：claude 本次回复失败 ...`

修复：

- `detectMentionedLiveRoomMembers(...)` 返回 `matchType`
- Feishu 入口 `postFeishuMessageToBoundLiveRoom(...)` 只把 `explicit` 匹配当成自动路由目标
- 普通正文中的 agent 名称不再作为 Feishu 自动路由依据

结果：

- 只有显式 `$lcc` / `@claude` / 飞书原生 @ 才会路由到 Claude
- 粘贴错误文本不会把消息误送到 Claude

### 4. Claude 在 Feishu runtime 下补齐代理继承

文件：

- `src/lib/real-agents/claude-agent.ts`

问题：

- `codex` 已有 runtime 专用代理环境恢复逻辑
- `claude` 直接继承 `process.env`
- 但 Feishu runtime 启动时会先 `env -u http_proxy ...`
- 导致 Claude 在 Feishu runtime 下和终端手工执行的联网行为不一致

修复：

- 为 Claude 增加 `buildClaudeChildEnv()`
- 复用：
  - `FEISHU_RUNTIME_CODEX_HTTP_PROXY`
  - `FEISHU_RUNTIME_CODEX_HTTPS_PROXY`
  - `FEISHU_RUNTIME_CODEX_ALL_PROXY`
  - `FEISHU_RUNTIME_CODEX_NO_PROXY`

结果：

- Claude 在 Feishu runtime 下与 Codex 一样，能够恢复代理环境变量

### 5. Feishu 非纯文本消息的最小可用解析

文件：

- `src/lib/feishu.ts`
- `src/lib/feishu-long-connection.ts`

问题：

- 旧逻辑只接受 `content.text`
- 图片、富文本、文件、语音、视频、表情等消息会直接 `return null`
- 表现为：
  - 图片消息“像掉线一样没反应”
  - 富文本消息被完全忽略

修复：

- 新增 `parseFeishuMessageContent(messageType, rawContent)`
- 统一在 webhook 路径和 long-connection 路径复用
- 当前支持将不同消息类型转成文本占位：
  - `text` -> 原文本
  - `image` -> `[图片消息] image_key=...`
  - `file` -> `[文件消息] ...`
  - `post` -> `[富文本消息]`
  - `audio` -> `[语音消息]`
  - `media` -> `[视频消息]`
  - `sticker` -> `[表情消息]`

结果：

- 非文本消息不再在解析层被直接丢弃
- 现在至少能被转发进 live-room / task room 作为一条可见消息

## 已验证结论

### A. 本地 Claude 认证现状

中途曾出现：

```text
Failed to authenticate. API Error: 401
Invalid authentication credentials
```

后续用户重新登录 Claude 后，本机验证：

```text
claude --print "reply with exactly OK"
```

返回：

```text
OK
```

说明：

- 当前本机 Claude 认证已恢复
- 后续如果 Feishu 链路再卡住，更可能是 session / runtime 状态问题，而不是认证问题

### B. 当前图片解析的能力边界

当前只做到：

- **识别图片消息**
- **保留 `image_key`**
- **把图片作为一条占位文本消息进入上下文**

还没有做到：

- 从 Feishu 下载图片二进制
- 落盘缓存
- 把图片内容真正送入支持视觉的 agent / OCR / vision pipeline

## 当前未提交时工作树中与本轮相关的核心文件

- `src/lib/feishu.ts`
- `src/lib/feishu-long-connection.ts`
- `src/lib/live-room.ts`
- `src/lib/feishu-live-room.ts`
- `src/lib/real-agents/claude-agent.ts`
- 本 handover 文档

不建议纳入本轮提交：

- `.env`
- `prisma/dev.db`
- `logs/`
- `nohup.out`

## 下一步：真正的图片解析

下一位 agent / 下一轮工作，目标应是把“图片占位”升级为“真正图片输入”。

建议路线如下：

### 1. 先补 Feishu 图片下载能力

建议新增：

- `src/lib/feishu-api.ts` 中新增根据 `image_key` 拉取图片内容的方法

需要做的事：

- 用 app access token 调 Feishu 图片资源接口
- 根据 `image_key` 下载图片
- 存到平台临时目录，例如：
  - `.runtime/feishu-images/`
  - 或 `tmp/feishu-images/`

### 2. 定义图片消息的内部表示

建议不要继续只用一段纯文本，而是补充结构化元数据，例如：

- `messageType: image`
- `imageKey`
- `localImagePath`
- `mimeType`
- `width/height`（如可取）

### 3. 决定图片如何真正进入 agent

这里要分清两条链：

- **短期最稳妥**：
  - 给文本 prompt 附上本地图片路径
  - 并在支持图片输入的链路中把图片作为额外 input item 送入

- **兼容保底**：
  - 若当前 harness 不支持图片输入，则自动降级成：
    - `[图片消息] local_path=... image_key=...`
  - 同时明确告诉用户“当前 agent 只能看到图片占位，不能视觉理解”

### 4. 优先在 Feishu long-connection 入口打通

原因：

- 当前主使用路径就是 Feishu 长连接
- 只要这条链先通，用户体验就已经明显改善

### 5. 真正完成后的验收标准

至少验证：

1. 在飞书发一张图片
2. 日志不再出现 parse failed
3. 平台能把图片下载到本地临时目录
4. agent 收到的不是简单占位，而是可用于视觉理解的输入
5. 如果 agent 不支持视觉，也应给出明确降级提示，而不是静默忽略

## 一句话总结

本轮已经完成：

- Feishu 群命令 `@机器人 /ap ...` 修复
- 中文标点下 `$lcc/$lcx` 提及修复
- Feishu 正文误把 `claude` 当点名的修复
- Claude 在 Feishu runtime 下代理继承补齐
- 图片/富文本/文件等非文本消息的“最小可用解析”

下一步真正需要做的是：

- **把图片从“占位文本”升级成“真实图片输入链路”**
- 核心工作在于：**根据 `image_key` 下载图片，并把图片作为结构化输入传给支持视觉的 agent**
