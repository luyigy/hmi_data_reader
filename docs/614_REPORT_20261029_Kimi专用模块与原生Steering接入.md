# Kimi 专用模块、进度与原生 Steering 接入

2026-10-29，Feishu DM 08a216。用户先确定 613 的模块化方向与按项细化方式，随后明确“你直接执行吧”。本轮在 `feat/kimi-session-adapter-20261029` 隔离工作区实施、自测，再合入运行目录；未创建自动任务路线。

## 结果

平台默认改用 Kimi 原生 Server + WebSocket。Kimi 协议、认证、原生会话、消息队列与进程生命周期封装在专用模块中；平台公共层通过适配器声明的 `supportsSteering` 能力工作，不解析 Kimi 协议。

- 能报告真实的思考状态、正文增量、工具及子代理进度；不转发原始私有思考文本，不把进度预览的长度限制用于最终答复。
- 运行中追加先进入原生 prompt 队列，再调用原生 steer。在下一次可消费输入的模型步骤生效，不承诺立即打断正在执行的工具。
- 同一消息 ID 只提交一次，明确拒绝才可回到平台排队；请求已发出但回执缺失标为 unknown，不自动重发。
- 原生 Session 可跨进程续用，兼容旧 print 会话；模型、上下文及累计 token 继续从限定当前执行时间范围的 wire 记录读取，会话大小继续用原生文件采样。
- 每次执行启动私有 loopback Server，随机端口、Bearer 认证，不启动浏览器或 Remote Control。桥接与 Kimi 在同一个原有沙箱内；不为连接 Server 放宽网络或目录权限。
- 停止、超时、服务退出和 WebSocket 断线都会清理本次进程；断线会明确失败，保留可续聊的原生会话，不自动回放 prompt。

实际验证版本是本机 Kimi **2.3.1**，Node **22.22.1**。Server API 属实验接口，未来升级须重跑原生测试。此变更针对 `platform_local` Kimi；不把未验证的远端 Kimi 标为支持。

## 实施前确定的边界和现场发现

1. 安装版本的 `--prompt --output-format stream-json` 省略 thinking，并不是补平台解析分支就能恢复。ACP 方法探测也不能替代 Server 能力验证。
2. 使用已安装二进制、临时 Kimi Home、本地确定性模型桩，未调用外部模型，也未向目标群发送测试消息。
3. Server 的冷会话必须先通过 status 加载，再订阅事件；新会话必须显式选取已配置默认模型。初轮测试发现这两个差异后分别修正，并覆盖连续两轮真实执行。
4. 原生 transcript 使用 payload.seq；重复批次丢弃、缺口失败，不混用外层事件序号。初始 reset 只是历史基线，不重新显示旧回复。
5. 平台公开能力只增加一个可选方法，未重写所有能力对象。房间派发、执行注册与 participant 回调传递三处均消费这一接口；workflow completion gate 等既有限制保留。
6. GitNexus 对共享接口给出高风险影响提示；结合实际调用点检查，并回归 Pi/Codex、房间及会话采样路径。未把索引结果当成运行证明。

## 验证

通过：

- `npm run test:kimi-server`：transcript 历史过滤、Agent 隔离、序号去重/缺口、思考隐私、完整最终回复、子代理上限；适配器能力；accepted/rejected/unknown 回执；重复消息；断线、超时、停止、服务异常退出及后代清理。
- `KIMI_SERVER_NATIVE_BIN=/home/hello/.kimi-code/bin/kimi npm run test:kimi-server-native`：真实 Kimi，共 7 次本地模型调用；Bash 真实执行；两条插话在同一执行中各消费一次；进程重启后续用同一 Session；Server → print → Server 双向续聊；只读工作区写入失败、未挂载文件不可见；隔离网络内仍能完成本机 Server 认证访问。
- 上述原生测试同时核对 wire 模型、128000 的配置窗口、两次模型调用的累计 246 token、原生会话文件大小。数值来自确定性测试响应，不代表用户实际会话用量。
- Kimi runtime-state、context、proxy、telemetry；Live Room progress、steering（新增 Kimi 及 print 回退实际派发入口用例）、execution-timeout；multi-agent-session-size；Pi RPC、Codex steering。
- `npm run build` 完整通过，包含 W001、ticket admission 和真实 Codex 的 W01 前置检查；`npm run check:long-files`、TypeScript 与 `git diff --check` 通过。

基线问题：`tests/kimi-code-agent.test.ts` 第一条源码正则断言仍期待旧内联超时逻辑，而现有实现已抽到 `resolveLiveRoomExecutionWatchdogConfig`。在未改动的主工作区同样立即失败；本轮未将其标为通过或改写该历史综合测试。旧 print 的可用性由上述真实 CLI 回退测试验证，现有 session-size 模拟 CLI 明确指定 print。

## 集成、重载与回退

源码集成到 `/data1/code/agent-platform-v2`。服务会读取此工作区；已集成不等于所有常驻进程已经重载。

当前 Agent 的进程属于 `agent-platform-feishu.service`，立即重启会中断本次回复。此次不在活动会话中执行重启、不安排后台定时重启。等活动任务结束后重载：

```bash
systemctl --user restart \
  agent-platform-dev.service \
  agent-platform-feishu.service \
  agent-platform-scheduled-jobs.service \
  agent-platform-task-graph.service \
  agent-platform-task-graph-feishu.service
```

无需新开 Kimi Session。目标群 `oc_de916b89cc41e2760e757cdd7b584c89` 的下一轮及插话仍需在重载后观察；本轮没有冒充目标群在线验收。

如需回退，在服务环境中设置 `KIMI_CODE_TRANSPORT=print` 后重载。此时保留原生 Session，适配器自动关闭 steering 能力，新增消息按原队列处理。回退是显式操作；不会在一次 prompt 可能已被接收后偷偷换通路重跑。

## 修改文件

专用模块：

- `scripts/kimi-session/bridge.cjs`
- `scripts/kimi-session/transcript.cjs`
- `src/lib/real-agents/kimi-server.ts`
- `src/lib/real-agents/kimi-code-agent.ts`
- `src/lib/harness/adapters/kimi-code.ts`

统一能力与派发：

- `src/lib/harness/types.ts`
- `src/lib/harness/registry.ts`
- `src/lib/harness/adapters/codex.ts`
- `src/lib/harness/adapters/pi-agent.ts`
- `src/lib/harness/adapters/antigravity.ts`
- `src/lib/acpx/runner-participant.ts`
- `src/lib/live-room-delivery.ts`
- `src/lib/live-room-delivery-execution.ts`

测试、入口及文档：

- `tests/fixtures/kimi-web.cjs`
- `tests/kimi-server.test.ts`
- `tests/kimi-server-native.test.ts`
- `tests/kimi-transcript.test.cjs`
- `tests/live-room-steering.test.ts`
- `tests/multi-agent-session-size.test.ts`
- `package.json`
- `docs/613_ROADMAP_20261029_Kimi专用可插拔接入.md`
- 本报告。
