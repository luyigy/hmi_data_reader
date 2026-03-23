# 20 ACPX Task Room Chat Layout Handover

## 日期
2026-03-23

## 目的
这份 handover 用于把当前 ACPX task room 的聊天界面改造状态交接给下一会话，尤其是：
- participant-targeted room message 已经落地到什么程度
- task room 聊天布局已经改到了哪里
- 当前最真实的未完成问题是什么
- 下一会话最应该先做什么

## 本轮已经完成的部分

### 1. task room message target 已落地
当前 room message 已支持：
- `task`
- `participant`
- `all`

已落地点：
- `Message` 新增 target 相关字段
- task room context 会把 target 语义写进上下文
- control route 会记录 room target
- `/tasks/[id]/chat` 可选择发给整个任务、单个 participant、或全部 participant

相关文件：
- `prisma/schema.prisma`
- `src/lib/chat-types.ts`
- `src/lib/task-room.ts`
- `src/lib/task-room-targets.ts`
- `src/app/api/chat/messages/route.ts`
- `src/app/api/tasks/[id]/control/route.ts`
- `src/app/tasks/[id]/chat/page.tsx`

### 2. task room 已改成更接近聊天产品的结构
已经做过的改动：
- 原三列布局被收敛成：
  - 左侧主聊天区
  - 右侧运行侧栏
- 主区将：
  - room messages
  - run events
  合并成一个 conversation feed
- 输入区已被放到主聊天卡片底部
- 自动滚动已改成“只有接近底部时才自动跟随”
- 如果手动向上查看历史，不会再被新消息强行拉回底部

### 3. socket `3001` 冲突已有降级处理
当前如果 `3001` 端口被占用：
- `/api/socket` 不再把页面直接炸掉
- 页面会切换到轮询刷新
- UI 会显示 socket unavailable notice

### 4. 已确认正确实例是 `127.0.0.1:3010`
本轮中途曾错误查看 `127.0.0.1:3000`，那不是用户正在使用的实例。

后续 ACPX task room 的真实 UI 调试，应以：
- `http://127.0.0.1:3010`
为准。

### 5. 聊天页已继续向“经典 ChatGPT 风格”收敛一轮
这一轮已明确把 `/tasks/[id]/chat` 往“聊天优先”方向推进，而不是继续保留 dashboard / control room 风格。

本轮实际做法：
- 顶部 header 改成更薄的一层，只保留：
  - task room 名称
  - task 名称
  - 连接状态 / run 状态 / activity
  - 开始运行按钮
- participant badges、socket 状态、聊天模式提示，被压成轻量 pills
- 主区采用更明显的聊天产品结构：
  - 上方轻量状态条
  - 中间大面积 conversation feed
  - 下方固定 composer
- room message 气泡改得更像聊天产品：
  - 用户消息右对齐深色气泡
  - 其他消息 / 事件改成浅色卡片
- 右侧区域进一步降级成桌面端侧栏：
  - `Run History`
  - `Selected Run Summary`
  - `Participant Outcomes`
  在窄屏下不再优先占据主布局
- 底部输入区已改成更紧凑的 composer 卡片，并再次压缩一轮：
  - textarea 从更高输入框收敛成 `rows=2`
  - 外层 padding 继续减小
  - 给上方聊天历史区让出更多高度
- 顶部轻量 pills 和 run event 卡片又继续降噪一轮：
  - participant / socket pills 更轻
  - run event 卡片颜色和标签对比度降低
  - 让 room message 更像主角，run event 更像辅助上下文

本轮用户反馈：
- “now it feels much better”
- “more like chatgpt feel”

这说明当前方向是对的：
- 应继续坚持“聊天优先”
- 不要再把顶部说明、运行解释、控制信息重新做大

### 6. `/favicon.ico` 的 500 更像是 dev 构建缓存问题，不是源码损坏
本轮用户遇到：
- `/favicon.ico` 500
- `MODULE_NOT_FOUND`
- require stack 指向 `.next/server/app/favicon.ico/route.js`

本轮排查结果：
- `src/app/favicon.ico` 文件本身存在，且内容正常
- 生产构建阶段能正常经过编译，不存在“favicon 文件缺失”这类源码级错误
- 问题更像是：
  - 当前 dev server 使用了过期或不一致的 `.next` 产物
  - 旧的 metadata route / chunk 引用关系已经失配

本轮采取的处理：
- 没有继续硬改 favicon 资源本身
- 已将旧的 `.next` 目录挪走为：
  - `.next-stale-20260323-favicon`

下一步建议：
- 重启 dev server，让 Next 重新生成全新的 `.next`
- 若 favicon 仍报错，再考虑单独重做 icon 资产，而不是先怀疑 chat page 改动

### 7. `socket unavailable: Socket port 3001 is already in use` 的含义已基本明确
这个提示的含义不是“任务消息发不出去”，而是：
- 平台原本想建立一个实时 socket 通道
- 这个通道依赖本地 `3001` 端口
- 但当前 `3001` 已经被别的进程占用，所以实时 socket server 无法正常接管该端口

这个 socket 的用途主要是：
- 实时推送 room messages
- 实时推送 run events
- 避免页面只能靠轮询才能看到最新状态

当前系统已经有降级逻辑：
- 即使 `3001` 冲突
- `/api/socket` 也不会把页面炸掉
- 页面会退回到 polling
- chat page 仍然可以通过轮询刷新拿到消息和 run 状态

因此目前更合理的判断是：
- `3001` 被占用，会影响“实时感”
- 会让页面看起来更迟钝、不像即时聊天
- 但它不是当前“消息记录了却没有自然回复闭环”的唯一解释，更不像唯一根因

更准确地说，当前“用户感觉 agent 没回复”更可能来自两层叠加：
- 一层是实时 socket 不可用，导致 UI 没有流式 / 即时反馈，体感变差
- 另一层是 ACPX 当前 `queue_message` / `interrupt_now` / 新 run continuation 之间的语义仍不够自然，导致用户消息虽然进入系统，但没有形成像聊天产品那样直接、自然的回应闭环

后续判断建议：
- 不要把 `socket unavailable` 直接等同于“agent 没有收到消息”
- 先区分：
  - 消息是否已写入 room / control log
  - agent 是否在后续 run 中真的消费了这条消息
  - UI 是否只是因为没有实时通道而显得没反应

### 8. 已确认 `3001` 的占用方是 Docker 端口映射，socket 默认端口已改到 `3101`
本轮排查发现：
- 宿主机 `3001` 当前由 `docker-proxy` 监听
- 这是容器端口映射，不是当前 Next dev 自己占用

因此本轮已将 ACPX chat realtime socket 的默认端口从：
- `3001`
改为：
- `3101`

已改位置：
- `src/lib/websocket.ts`
- `src/lib/websocket-client.ts`
- `.env`
- `.env.example`

这次调整的目的：
- 避开宿主机已有 Docker 映射
- 恢复 task room 的 realtime push
- 降低“发了消息但页面没反应”的体感问题

注意：
- 改完后需要重启 dev server，新的 env 才会生效

### 9. 已确认 realtime socket 恢复后，当前“没自然回复”仍主要是 control 语义问题
在把默认 socket 端口切到 `3101` 并重启 dev server 之后，用户已观察到：
- 顶部状态显示为“实时连接中”
- `/api/socket` 返回正常
- `favicon.ico` 也恢复到 `200`

这说明：
- realtime socket 本身已经基本恢复
- 当前问题不能再继续归因为“socket 没连上”

但用户在恢复 realtime 之后仍然看到：
- 自己发给 implementer 的消息被记录
- 紧接着出现 `control_message`
- 系统提示明确写着：
  - “这条消息已作为排队指令记录，当前 run 不会被强制打断，下一次合适的 handoff 或 rerun 会看到它。”

这进一步确认了当前真实语义：
- 主发送按钮走的是 `queue_message`
- `queue_message` 目前不是“把消息实时送进当前 harness session”
- 它更像是“写入 room / control log，等待下一次 run 或下一阶段 handoff 再消费”

因此下一会话必须避免的误判是：
- 不能把“agent 没自然回复”继续简单归因为 socket

更准确的结论是：
- socket 恢复后，页面的实时感会更好
- 但当前产品语义仍然不是 ChatGPT 式原地 continuation
- 所以用户仍然会感觉：
  - “我发了消息，它记下来了”
  - “但 agent 没有立刻接着回我”

## 本轮实际确认的事实

### 1. Claude 远端 participant 能响应
用户已明确说明 claude agent 可以回复，并且本轮通过 task room 里的“测试远端连通性”按钮也看到了：
- `ACPX connectivity OK`

所以当前重点不应再判断为：
- “远端 Claude 完全不可用”

### 2. task room 页面顶部信息区已明显改善，但仍可继续收敛
当前页面上方占用过多垂直空间的区域主要包括：
- 页面标题卡片
- participant badges
- task room/info notice
- socket unavailable notice
- conversation card 顶部状态和提示

这些内容已经被压缩到比上一轮明显更轻，但还没有到“几乎感觉不到它们在抢空间”的程度。

用户的明确反馈是：
- 聊天历史区应当尽可能大
- 输入区也可以继续收一点
- 这页应该优先服务“聊天”，不是服务“说明文字”

### 3. 当前最真实的未完成问题不是“历史没有数据”，而是“聊天主区空间分配还可以继续优化”
在正确实例 `3010` 上，已确认：
- `/api/tasks/[id]/runs`
- `/api/tasks/[id]/runs/latest`
都有数据
- 页面 conversation feed 也确实能渲染消息和 run events

因此当前不能再把问题误判成：
- “聊天历史没加载”

更准确地说，当前问题是：
- 聊天历史区已经比之前大很多，但还可以继续争取
- 页面上半部分与 composer 仍有进一步压缩空间

### 4. 用户发给 agent 的消息“已记录”，但缺少自然回复闭环
当前用户明确反馈：
- 给 agent 发消息后，消息被记录了
- 但用户没有感觉到 agent 在自然回应这些消息

这说明当前虽然实现了：
- room message target
- queue/control recording

但还没有形成用户主观上“像在和 agent 真正对话”的体验。

需要注意：
- 这不一定是 transport 故障
- 在 socket 恢复后，这一判断更强了
- 更可能是 ACPX 当前 queued/immediate 语义与 run continuation 之间仍有断层

## 当前工作区状态
本轮尚未提交的修改主要在：
- `prisma/dev.db`
- `src/app/api/tasks/[id]/control/route.ts`
- `src/app/api/tasks/[id]/route.ts`
- `src/app/api/tasks/[id]/runs/latest/route.ts`
- `src/app/api/tasks/[id]/runs/route.ts`
- `src/app/tasks/[id]/chat/page.tsx`
- `src/lib/acpx/liveness.ts`
- `src/lib/acpx/runner.ts`

这些改动包含：
- task room 主发送按钮与 request card 的“诚实语义”文案
- `queue_message` / `interrupt_now` 的 UI 提示与后端 system notice 对齐
- local harness spawn 后记录 PID 到 run / participant `controlMetadata`
- 读 task / runs / latest / control 入口时，自动 reconcile stale local run
- 若 DB 仍是 `running`，但本地 `codex` 进程已消失，则自动收口为 failed / interrupted / stopped

## 本轮新增确认

### 1. 当前 local Codex 不是“可持续对话 session”
当前 local Codex 的真实执行方式仍是：
- spawn 一次 `codex exec`
- 写入单次 prompt
- 立刻关闭 stdin
- 等 stdout / stderr 或退出

这意味着：
- 当前并没有“把下一条用户消息写回同一个 harness session”的通路
- `queue_message` 只能进入 task room / control log
- 后续只会在下一次 run 或下一阶段 handoff 里被重新拼进 prompt context

结论：
- 现在的 ACPX chat 还不是“真实聊天 continuation”
- 更准确地说，它仍是“带聊天外观的 run orchestration UI”

### 2. 已定位“看起来一直在跑，其实本地进程已经没了”的真实故障
本轮直接检查服务器进程后确认：
- 某个 `platform_local / codex` participant 在 DB 中仍显示 `running`
- 但宿主机上已不存在对应 `codex exec` 子进程

这说明之前的系统确实会出现：
- UI 和 DB 以为 harness 还活着
- 实际本地子进程早已退出或消失
- 页面继续表现成“长时间运行但没回应”

### 3. stale-run / liveness reconcile 已落地第一版
本轮已经新增：
- `src/lib/acpx/liveness.ts`

它会在读取这些入口前先做一次 reconcile：
- `/api/tasks/[id]`
- `/api/tasks/[id]/runs`
- `/api/tasks/[id]/runs/latest`
- `/api/tasks/[id]/control`

当前第一版规则：
- 若 run / participant 仍是 `running` 或 `waiting_for_input`
- 且 participant 是 `platform_local`
- 且进程注册表里找不到它
- 且 PID 也不存在或不再像对应 harness
- 且已超过短暂 grace period

则平台会自动：
- 把 participant 收口为 `failed` / `interrupted` / `stopped`
- 把 run 收口为 terminal 状态
- 清掉 session `activeRunId`
- 写入 `participant_failed` / `run_failed` 等事件

### 4. 当前 liveness 仍只覆盖“本地 harness 真死了”的场景
这次已解决的是：
- 本地进程明明没了，但 UI 还一直显示运行中

这次还没有真正解决的是：
- 本地 harness 仍活着，但长时间安静
- 远端 OpenClaw / Claude final-only 执行时，怎么区分 quiet / stalled / dead
- 真实 heartbeat / watchdog product model

所以当前 liveness 的真实状态应表述为：
- local dead-process reconcile：已有第一版
- quiet vs stalled：还没有完整产品层定义
- remote liveness：仍不足

## 下一阶段目标

### 核心目标
把 `/tasks/[id]/chat` 从“消息被记录，等待下一轮 run 消费”推进到：
- 用户发消息后，当前 direct harness 能继续读到
- harness 的后续输出继续回到同一条聊天流
- 用户主观体验更像真正的 ChatGPT / Claude 式连续对话

这次不要再把目标描述成抽象的“优化体验”。
更准确地说，下一阶段要做的是：
- direct local harness 的真实 continuation 通路
- 为 continuation 配套的状态与 UI 约束

## 下一阶段实施计划

### Phase 0. 先把 continuation 范围收窄到 local direct harness
先只做：
- `platform_local`
- `codex`
- 可能再兼容 `claude`

先不要假装：
- `gateway_openclaw` 也能同样工作
- 所有 harness 都支持 current-session injection

目标：
- 先在最可控的一条链路上实现真实 continuation

### Phase 1. 把 local harness 从“一次性 exec”改成“可持续 session”
最小实现目标：
- spawn local harness 后不要立刻关闭 stdin
- process-registry 不只保存 `child`
- 还要保存：
  - `pid`
  - session writable stdin availability
  - startedAt / lastSeenAt
  - harnessType / taskRunId / participantId

必要工作：
- 为 Codex direct run 设计可持续 stdin 写入协议
- 确认 `codex exec` 是否真的适合 continuation
- 如果 `codex exec` 天然不适合，就需要切到更适合 session control 的命令模式或 wrapper

完成标志：
- 平台能向当前活着的 local harness session 写入一条 continuation message
- 不必通过“中断 + 新 run”来伪装继续

### Phase 2. 新增真正的 `continue_session` / `inject_message` 控制动作
当前控制动作只有：
- `queue_message`
- `interrupt_now`
- `stop_run`

下一步建议新增：
- `continue_session`
  - 仅在 harness capability 明确支持时启用

真实语义应是：
- 如果当前 participant 是 local direct harness，且 session 可写
- 用户消息直接写入当前 session
- 不新建 `TaskRun`
- 不强制中断

同时保留：
- `queue_message`
  - 继续表示“后续轮次再消费”
- `interrupt_now`
  - 继续表示“马上打断并准备转向”

### Phase 3. 在数据模型里显式标记“消息是排队还是已注入当前 session”
当前 message / control flow 还缺一层关键可观察性：
- 用户发出去后，到底是 queued
- 还是 delivered to active session
- 还是 rejected / fallback to queue

最小目标：
- control message metadata 里记录：
  - target participant
  - delivery attempt
  - session injection result
  - fallback reason

UI 最少要能明确显示：
- 已写入当前 session
- 当前 harness 不支持 continuation，已改为排队
- 当前 session 已失活，无法继续注入

### Phase 4. 把聊天 UI 改成真正区分三种发送模式
主发送体验不能再只有一个模糊主按钮。

建议最小交互：
- 主按钮：
  - 若当前 active participant 支持 continuation，则默认“继续当前对话”
  - 否则默认“排队到后续轮次”
- 次按钮：
  - `排队到后续轮次`
  - `打断并转入下一轮`

并且在 composer 上方明确提示：
- 当前是“live continuation”
- 还是“queue for later”

### Phase 5. 把 stdout / stderr 事件和 continuation 回复串成自然聊天闭环
continuation 成功后，用户还需要在 UI 上感知：
- 我的消息已经送进去了
- agent 正在继续思考 / 输出
- 新输出属于“继续当前对话”，不是“另一轮莫名其妙的 run event”

建议最小落地：
- 给 continuation 注入写一条轻量 system event
- 后续 stdout_chunk 在视觉上更像“agent reply streaming”
- 降低 run event 的控制台感，增强聊天连续性

### Phase 6. 最后再回到 approval / input request 的真交互
只有在 current-session continuation 打通后，再回头做：
- permission approval
- input request submit
- choice request submit

因为这三类交互真正成立的前提就是：
- 平台已经能把用户输入送回当前 harness session

如果这个前提没成立，approval UI 仍然只会是“模板消息 + 下一轮重跑”。

## 下一会话建议优先级

### P0. 验证 local Codex 哪种命令模式适合真实 continuation
先不要急着改 UI。
先确认技术事实：
- `codex exec` 是否允许持续 stdin 写入并在同一进程里继续
- 如果不适合，应该切到什么命令模式或 wrapper

这一点是整个 continuation 的关键 blocker。

### P1. 在 process-registry 上扩展 session write 能力
最小目标：
- 除了 kill 进程，还能向 active local harness 写入 continuation message
- 能明确知道这次写入成功、失败还是 fallback

### P2. 新增 `continue_session` control action 与 API 语义
最小目标：
- 后端先打通
- 前端先不做复杂交互
- 先能通过一个受控入口把消息送到当前 local harness

### P3. 再把 chat composer 升级成“真实 continuation 优先”的 UI
最小目标：
- 当前 harness 支持 continuation 时，主按钮默认继续当前对话
- 否则明确 fallback 为 queue

## 建议下一会话先读
1. `docs/16_ACPX_INTERACTIVE_RUN_CONTROL_PLAN.md`
2. `docs/19_ACPX_TASK_ROOM_CONTROL_HANDOVER.md`
3. `docs/20_ACPX_TASK_ROOM_CHAT_LAYOUT_HANDOVER.md`
4. `src/lib/acpx/liveness.ts`
5. `src/lib/acpx/runner.ts`
6. `src/lib/real-agents/codex-agent.ts`
