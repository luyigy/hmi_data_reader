# 67. PROCESS_STABILITY_AND_FEISHU_RESOURCE_DOWNLOAD_HANDOVER

## 日期

2026-04-07

## 本轮目标

本轮主要推进两件事：

1. 把 `npm run dev` 和 `npm run feishu:runtime` 从脆弱的 `nohup ... &` 模式，切到更稳定的 `systemd --user`
2. 让 Feishu 图片/文件/语音/视频消息不只是“占位文本”，而是尝试把资源真正下载到本地，并把本地路径带入消息上下文

## 已完成

### 1. 用 `systemd --user` 接管 Web 和 Feishu Runtime

新增文件：

- `scripts/run-agent-platform-dev.sh`
- `scripts/run-feishu-runtime.sh`
- `scripts/install-systemd-user-services.sh`
- `deploy/systemd-user/agent-platform-dev.service`
- `deploy/systemd-user/agent-platform-feishu.service`

核心思路：

- 不再依赖：

```bash
nohup npm run dev > ...
nohup npm run feishu:runtime > ...
```

- 改由 `systemd --user` 接管
- 服务具备：
  - 自动重启
  - 登录后自动拉起
  - `systemctl --user status` 可观测
  - `journalctl --user -u ...` 统一日志

当前实际服务名：

- `agent-platform-dev.service`
- `agent-platform-feishu.service`

当前实测状态：

- 两个服务都已经通过 `systemctl --user status` 看到 `active (running)`

### 2. Feishu 资源消息下载链路

修改文件：

- `src/lib/feishu-api.ts`
- `src/lib/feishu.ts`
- `src/lib/feishu-long-connection.ts`
- `src/app/api/feishu/webhook/route.ts`

#### 2.1 新增消息资源下载能力

在 `src/lib/feishu-api.ts` 中新增：

- `downloadFeishuMessageResource(...)`

作用：

- 使用 Feishu `message resource` 接口
- 根据：
  - `message_id`
  - `file_key`
  - `type`
- 下载用户消息中的资源文件

当前落盘目录：

- `.runtime/feishu-message-resources/`

当前会根据响应头大致推断后缀：

- `png`
- `jpg`
- `webp`
- `gif`
- `bmp`
- `heic`
- `mp4`
- `mp3`
- `wav`

#### 2.2 Feishu 消息解析不再只返回一段 text

`parseFeishuMessageContent(...)` 已从“只返回字符串”改成返回结构：

- `text`
- `messageType`
- `fileKey`

这样后续可以区分：

- `text`
- `image`
- `file`
- `audio`
- `media`
- `post`
- `sticker`

#### 2.3 新增资源注水（hydrate）步骤

新增：

- `hydrateFeishuMessageResources(...)`

作用：

- 若消息类型是：
  - `image`
  - `file`
  - `audio`
  - `media`
- 且有 `fileKey`
- 则尝试下载资源，并把结果追加回消息文本

当前追加格式类似：

```text
[图片消息] image_key=... local_path=/data1/code/agent-platform-v2/.runtime/feishu-message-resources/... content_type=image/png size_bytes=12345
```

#### 2.4 两条入口都已接入

已接入：

- Feishu long-connection 路径
  - `src/lib/feishu-long-connection.ts`
- Feishu webhook 路径
  - `src/app/api/feishu/webhook/route.ts`

这样不管当前是长连接还是 webhook，都可以走同一套资源注水逻辑。

## 仍需继续的部分

### 1. 真正的“视觉理解”还没完成

当前做到的是：

- 图片消息被识别
- 图片资源被下载
- 本地路径进入消息上下文

当前还没做到的是：

- 把图片作为真正的多模态输入传给 Codex / Claude harness
- 或者接一层 OCR / vision 模型，把图片内容转成可理解文本

也就是说：

- 现在已经不是“纯占位”
- 但还没有到“agent 真正看图并理解图像内容”的阶段

### 2. `post` 富文本消息仍然只是占位

当前：

- `post` -> `[富文本消息]`

还没做：

- 解析富文本 JSON，把实际文字内容展开

### 3. 建议下一步优先级

建议顺序：

1. 先把 `post` 富文本展开成真实文本
2. 再打通“图片本地路径 -> harness 真正可消费的图片输入”
3. 如果当前 harness 不支持直接图片输入，再补一层 OCR/vision 降级

## 当前推荐的常用 systemd 命令

见单独文档：

- `docs/SYSTEMD_USER_COMMANDS.md`

## 本轮相关文件

建议纳入本轮提交的文件：

- `src/app/api/feishu/webhook/route.ts`
- `src/lib/feishu-api.ts`
- `src/lib/feishu-long-connection.ts`
- `src/lib/feishu.ts`
- `scripts/run-agent-platform-dev.sh`
- `scripts/run-feishu-runtime.sh`
- `scripts/install-systemd-user-services.sh`
- `deploy/systemd-user/agent-platform-dev.service`
- `deploy/systemd-user/agent-platform-feishu.service`
- `docs/67_PROCESS_STABILITY_AND_FEISHU_RESOURCE_DOWNLOAD_HANDOVER.md`
- `docs/SYSTEMD_USER_COMMANDS.md`

不要混入：

- `.env`
- `prisma/dev.db`
- `logs/`
- `nohup.out`

## 一句话总结

本轮已经把“后台进程稳定性”从 `nohup` 提升到 `systemd --user`，同时把 Feishu 图片/文件等资源消息推进到“真正下载到本地并携带路径进入上下文”的阶段；下一步应继续补 `post` 富文本展开，以及真正把图片输入传递给支持视觉的 harness。
