# 71. FEISHU_CODEX_STABILITY_AND_PROGRESS_HANDOVER

## 日期

2026-04-12

## 本轮目标

先把 Feishu 中和本地 `codex` 的对话稳定下来，优先解决：

1. Codex continuation 反复绑死在旧 thread 上
2. Feishu 侧执行中完全不可见，只有 typing / 最终失败
3. systemd user service 启动后丢失代理环境，导致 Codex 直连 websocket 失败

---

## 关键结论

### 1. Codex 之前的主要不稳定点不是单一原因

本轮确认至少有三层问题：

- **旧 continuation thread 会失效**
  - 典型报错：`timeout waiting for child process to exit`
  - 典型报错：`failed to refresh available models`
- **Feishu 执行过程不可见**
  - 用户看起来像“完全没工作”，只能等最后一句成功/失败
- **systemd user service 丢代理**
  - 典型报错：`failed to connect to websocket: IO error: Network unreachable (os error 101)`
  - 运行日志里明确出现：`Proxy enabled: false`

### 2. 代理丢失的根因已确认

`deploy/systemd-user/*.service` 调用的启动脚本此前使用：

```bash
bash -lc '...'
```

但用户的 `~/.bashrc` 在非交互 shell 下开头直接 `return`，所以：

- `http_proxy`
- `https_proxy`
- `all_proxy`
- `nvm`

都没有进入 Feishu runtime 进程。

改成：

```bash
bash -ic '...'
```

之后，runtime 启动日志中的 Node 版本已经从系统 `v22.22.0` 变成 nvm 的 `v22.22.1`，说明 `~/.bashrc` 已经被加载。

---

## 本轮实现

### A. 本地 Codex 在 Live Room 中默认改为 transcript continuation 优先

文件：

- `src/lib/live-room-delivery.ts`

改动：

- 对 `platform_local + codex`，默认**不再优先使用旧 `thread_id` continuation**
- 直接基于 task-room transcript 继续聊
- 只有其他 harness / backend 继续沿用原有 continuation 逻辑

目的：

- 避免一条失效的旧 Codex thread 把整条 Feishu 会话拖死

### B. Codex continuation 失效判定增强

文件：

- `src/lib/acpx/continuation-retry.ts`
- `src/lib/live-room-delivery.ts`

新增判定：

- `timeout waiting for child process to exit`
- `failed to refresh available models`

效果：

- 命中这些错误时，系统更容易回退到 fresh session，而不是继续死磕旧 thread

### C. Feishu 可见执行状态补齐

文件：

- `src/lib/acpx/types.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/live-room-delivery.ts`

改动：

- `AcpxRunRequest` 增加可注入的 `streamCallbacks`
- `runner` 在原有 stdout/stderr 处理后，把 chunk 转发给调用方
- live room 把节流后的 stdout/stderr 摘要转成系统消息

当前用户可见效果：

- 先收到：`系统提示：xxx 已开始处理这条消息。`
- 执行中可能收到：`系统提示：xxx 正在处理中：...`

这版先不做 Feishu message edit，只做最小可用的“过程可见”

### D. systemd user service 启动脚本修复

文件：

- `scripts/run-feishu-runtime.sh`
- `scripts/run-agent-platform-dev.sh`

改动：

- 从 `bash -lc` 改为 `bash -ic`

目的：

- 让 user service 启动时也能加载 `~/.bashrc`
- 继承代理、nvm、PATH 等用户运行时环境

---

## 已执行操作

已重启：

- `agent-platform-dev.service`
- `agent-platform-feishu.service`

重启后已观察到：

- Feishu runtime 使用 `node v22.22.1`
- 表明 `.bashrc` 已被加载

---

## 仍需验证

用户需要继续在 Feishu 中验证两点：

1. `codex` 是否还会报 `Network unreachable`
2. 重启后的新一轮日志里 `Proxy enabled:` 是否变为 `true`

如果仍失败，优先继续查：

- `npm run feishu:runtime` 进程里最终看到的代理环境
- Codex CLI 是否实际读取了 `FEISHU_RUNTIME_CODEX_*_PROXY`
- 是否需要在 service unit 中显式 `EnvironmentFile=` 或固定代理变量，而不是依赖 shell 初始化

---

## 本轮涉及文件

- `src/lib/acpx/continuation-retry.ts`
- `src/lib/acpx/types.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/live-room-delivery.ts`
- `scripts/run-feishu-runtime.sh`
- `scripts/run-agent-platform-dev.sh`
