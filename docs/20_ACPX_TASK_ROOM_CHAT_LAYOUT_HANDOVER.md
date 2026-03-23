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
- 更可能是 ACPX 当前 queued/immediate 语义与 run continuation 之间仍有断层

## 当前工作区状态
本轮尚未提交的修改主要在：
- `prisma/dev.db`
- `prisma/schema.prisma`
- `src/app/api/chat/messages/route.ts`
- `src/app/api/socket/route.ts`
- `src/app/api/tasks/[id]/control/route.ts`
- `src/app/layout.tsx`
- `src/app/tasks/[id]/chat/page.tsx`
- `src/components/common/Sidebar.tsx`
- `src/lib/chat-types.ts`
- `src/lib/task-room.ts`
- `src/lib/task-room-targets.ts`
- `src/lib/websocket.ts`

这些改动包含：
- room message target 模型
- socket fallback
- chat layout 多轮调整
- ChatGPT-like chat page 收敛
- sidebar / root layout 调整

## 下一会话最优先事项

### P0. 继续压缩 task room 顶部信息区
目标：
- 把页面标题卡片高度继续缩小
- 把 task room/info/socket 说明继续收敛
- 让聊天历史区获得更大可见高度

建议方向：
- 将顶部标题区继续压成更紧凑的一行或两行
- participant badges 还能再缩
- notice 继续维持轻量状态栏，不要回退成说明块
- conversation card 顶部状态区继续减高

### P1. 把聊天主区真正做成“聊天优先”
目标：
- 让聊天历史区成为这页最大的视觉主体
- 输入区始终稳定可见
- 右侧侧栏只承担次要信息，不抢高度

建议方向：
- 进一步减少 feed 上方所有说明块
- 继续压缩 composer 高度
- 优先保住 feed height
- 必要时把更多次要状态移到右侧侧栏或折叠区域

### P2. 继续调查“消息发给 agent 后为何缺少自然回复”
当前现象：
- 用户消息已进入 room
- control message 也会记录
- 但用户仍然感觉“agent 没有回复我”

下一会话需要优先厘清：
- 当前消息究竟进入了哪一层 prompt context
- 是当前 run 中不会看到，还是下一 run 才会看到
- 是否需要在 UI 中明确反馈“这条消息何时会被 agent 真正消费”
- 是否应补一种更自然的 reply/system acknowledgment 机制

### P3. 若继续用浏览器调试，必须使用正确实例
必须使用：
- `http://127.0.0.1:3010`

不要再使用：
- `http://127.0.0.1:3000`

## 建议下一会话先读
1. `docs/19_ACPX_TASK_ROOM_CONTROL_HANDOVER.md`
2. `docs/20_ACPX_TASK_ROOM_CHAT_LAYOUT_HANDOVER.md`
