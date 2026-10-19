# 私聊意图与重跑进度卡修复

## 用户能看到的变化

- 询问“为什么没继续”、否定或转述，不再创建恢复请求，消息继续交给房间 Agent 回复。
- 私聊中的普通确认回复不再强制新建话题。
- 每个 TaskRun 在仓库原话题底部发独立进度卡，本轮更新自己的卡。历史共享卡绑定在下次投递时迁移。
- 派发前通知保持独立。同轮发送响应丢失后复用原 UUID；超过去重窗口时保留证据，不盲目重发。

## 复现与验证

先以两条真实用户消息和重跑发卡数量复现失败，再修改实现。原实现把第一条状态追问识别为恢复授权，重跑仍只有一张共享卡。

真实反例已写入 `tests/task-graph-continuation.test.ts`，并通过私聊入口验证它们会调用正常房间回复。明确授权的私聊确认验证 `replyInThread=false`。

隔离 PostgreSQL 测试覆盖：

- `task-graph-continuation`：否定、疑问、转述、明确授权、权限和目标选择。
- `task-graph-feishu-relay`：新 TaskRun 发新卡、旧共享绑定迁移、本轮原位更新、旧运行不能覆盖新卡。
- `task-graph-card-closure`：派发前通知与运行卡分开、发送去重、过期不确定发送拒绝重发、历史游标不阻塞当前投递。
- `task-graph-notification-recovery`：通知异常不改变业务执行状态。
- `task-graph-feishu-dm-relay`：明细仍回仓库话题。
- `task-graph-implementation-recovery`：候选保存、授权接续、未交付不误集成。

`npx tsc --noEmit --incremental false` 与 `npm run check:long-files` 通过。

## 加载边界

现有服务没有热加载接口。先在隔离子进程验证定向更新四个模块，保留原 exports 对象，已有调用方可以读到新函数。两条线上反例均返回 false，明确继续返回 true。

线上仅替换已缓存的 `conversation-intent`、`feishu-live-room`、`progress-card-delivery`、`run-reply-relay`，不替换协调器、不重启服务、不触发业务续跑。每个目标校验 PID、工作目录、入口脚本与源文件哈希；失败时恢复旧导出与模块缓存。临时调试端口仅监听本机并在操作后关闭。

实际加载结果及卡片回读另存 `service-load.json`。测试通过不代表 R05 业务问题已解决。
