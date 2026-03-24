# 24 ACPX Chat First Control And Session Mode Handover

## 日期
2026-03-24

## 背景
这份 handover 用于承接 `23_ACPX_PERMISSION_UI_AND_CHAT_POLISH_HANDOVER.md` 之后，用户在真实页面上继续暴露出来的一组更本质的问题。

这次需要明确的一点是：
- 当前问题已经不只是“某几个按钮灰掉”或“某些系统消息太大”
- 而是 task room 当前的产品模型，仍然没有真正切到用户想要的：
  - 先聊天
  - 再决定是否执行
  - 执行时可明确控制当前 active run
  - 尽可能接近 Codex CLI 那种 session-first 体验

## 用户最新真实反馈

用户当前明确指出了三件事：

### 1. 控制按钮依然不可用
页面已经刷新后，用户仍然看到：
- `打断并转入下一轮`
- `停止运行`

两个按钮是灰的。

同时页面文案显示：
- `当前控制目标：Selected Run（failed）`

这说明当前 UI 虽然新增了“控制目标”提示，
但并没有真正解决“控制目标到底该绑定哪条 run”的问题。

也就是说：
- 页面上方提示还在说“当前 harness 正在执行当前 turn”
- 但底部控制区却认为当前只能控制一个 `failed` 的 selected run

这两套状态彼此冲突。

### 2. 用户要的不是“先填 task，再点开始运行”，而是“先跟 agent 聊”
用户再次明确强调：
- 希望先和 agent 讨论任务
- 然后再要求 agent 去做事
- 整体体验像 Codex CLI

这不是一个小交互 tweak，
而是在要求产品模型从：
- run-first

切到：
- session-first / chat-first

### 3. 当前页面仍然没有真正出现“聊天模式”选项
虽然前面已经把“无 active run 时只写入 task room，不自动启动 run”往这个方向推了一步，
但用户明确指出：
- 他们没有看到自己要的 chat option

这说明当前实现的问题是：
- 我们只是在局部调整按钮语义
- 但没有把“聊天模式”和“执行模式”在 UI 上显式产品化

于是用户无法建立稳定心智：
- 现在到底是在聊天
- 还是在控制 run
- 还是在准备下一轮执行

## 当前更准确的问题判断

### 1. “控制按钮灰掉”不是单纯 disabled 条件问题，而是 run source of truth 混乱
当前页面至少同时存在几套 run 概念：
- `selectedRun`
- `runSummaries[0]`
- `currentTaskSession.activeRunId`
- feed 中正在展示的 event 所属 run

现在的问题不只是：
- 某个按钮条件写错了

而是：
- UI 没有一个单一、可信的“当前 active run”来源

导致：
- feed 可能在展示某条 run 的事件
- 侧栏可能选中另一条 run
- 控制区可能又基于第三条 run 做 enable/disable

因此会出现典型错位：
- 文案说还在执行
- 控制却落到 failed run

### 2. 当前 ACPX task room 仍然是“run room”，不是“chat session”
虽然页面叫 chat room / task room，
但当前真实行为仍更接近：
- run control room

因为：
- agent 不是一个长期存在的对话会话
- agent 只在 run 启动时被 spawn
- 用户消息在多数情况下只是：
  - queue 到下一轮
  - 或 continuation 到已有 Codex thread

这与用户要的：
- 先聊
- 再做

本质不同。

### 3. 当前“继续当前对话”只覆盖 continuation，不覆盖真正的 chat-first 首轮体验
现在已经接通的是：
- local Codex continuation
- 即：已有 thread 后，可以 `continue_session`

但用户要的还有另一半：
- 在没有 active run 时，也像在 CLI 里一样先聊天
- 让 agent 基于最新消息来理解任务
- 而不是一上来就只根据 task description 执行

当前这部分并没有真正被产品化。

## 为什么这件事不能再靠局部补丁推进

到目前为止做过的改动，大多属于：
- 调整按钮文案
- 调整 message 样式
- 修补 selectedRun 切换
- 修补 permission UI

这些都不是没价值，
但现在已经证明：
- 如果不先收敛 run/session/chat 的主语义
- 再多补按钮和 hint，都只会继续制造“表面像聊天，底层还是 run-first”的混乱

## 下一阶段必须先确立的产品原则

### 原则 1. 页面必须明确区分两种模式

#### A. Chat Mode
用于：
- 和 agent 讨论任务
- 澄清目标
- 形成计划
- 暂不启动执行

特征：
- 主按钮应是“发送到对话”
- 不默认产生新 run
- 不要求当前有 active run
- 可把这些消息积累为 session context

#### B. Run Mode
用于：
- 基于当前 task room / chat session 上下文
- 显式启动一轮执行

特征：
- 明确显示即将执行的参与方
- 明确显示本次 launch-time permission config
- 明确显示“将读取哪些上下文”

如果页面不把这两种模式显式分开，
用户会持续困惑。

### 原则 2. 控制区必须只服务 active run，不服务 selected run
用户点击：
- 打断
- 停止
- continue session

本质上是在控制：
- 当前 active run

而不是：
- 侧栏当前选中的历史 run

因此后续必须调整为：
- `selectedRun` 只决定你在看哪条历史
- `activeRun` 才决定控制按钮的启用状态与控制目标

并且 UI 上要显式写清：
- 当前控制目标：Run X（active）
- 不是当前浏览目标：Run Y（selected）

### 原则 3. “先聊天，再执行”必须有明确入口，而不是靠文案暗示
用户说的 chat option，实际上应该被产品化成明确入口，例如：
- `聊天模式`
- `开始执行`

或：
- `仅聊天`
- `基于当前对话启动 Run`

而不是只在 placeholder / notice 里偷偷表达。

## 推荐实施方案

### Phase 1. 先引入明确的 `activeRun` 概念
目标：
- 在 chat page 中单独维护 `activeRunSummary`
- 来源优先级：
  1. `task.currentTaskSession.activeRunId`
  2. 若无 activeRunId，再退到 `status === running / waiting_for_input` 的最新 run
  3. 若仍无，再视为无 active run

要求：
- 控制按钮一律基于 `activeRun`
- 控制 API 默认也以 `activeRun.id` 为目标
- `selectedRun` 只用于历史浏览，不再影响控制 enable/disable

### Phase 2. 把控制区和浏览区语义拆开
当前底部文案里同时混着：
- feed 浏览状态
- continuation 状态
- queue 语义
- 控制目标

下一版建议拆成：
- 浏览状态栏：
  - 当前查看：Run 26（failed）
- 控制状态栏：
  - 当前控制：Run 27（running）

这样用户不会再把“我在看哪条”和“我在控制哪条”混起来。

### Phase 3. 新增显式 `聊天模式 / 执行模式`
这是本轮最关键的产品改动。

建议在 composer 上方增加一个显式 mode switch，例如：
- `聊天模式`
- `执行模式`

#### 聊天模式
- 主按钮：`发送到对话`
- 行为：
  - 写入 task room
  - 不自动启动 run

#### 执行模式
- 主按钮：`基于当前对话启动 Run`
- 行为：
  - 明确以最近对话上下文 + task description + permission config 启动

这一步不是 cosmetic，
而是让用户第一次真正看到“chat option”。

### Phase 4. 重新定义“任务描述”和“当前消息”的权重
当前首轮执行仍然偏向：
- task description 为主

但用户真正想要的是：
- 当前对话最新消息，能主导 agent 下一轮行为

因此下一版 run launch prompt 需要调整为：
- task description 是背景
- task room 最近消息是最新上下文
- 若是明确从“执行模式”发起，则用户最后一条消息应成为当前 turn 的主指令

### Phase 5. 为长期目标预留 `session-first harness mode`
如果要更接近 Codex CLI，
长期需要：
- 先存在一个会话
- 再在该会话中多轮交互

对 local Codex 来说，当前最接近这个目标的基础是：
- continuation thread 已接通

但还缺：
- 首轮就以 session 为主，而不是 run 为主
- 无 active run 时也能先建立 agent-facing conversation state

这可能意味着未来需要新增：
- chat session metadata
- agent-facing conversation bootstrap
- run launch from session

而不是继续把所有状态都塞进 task run。

## 关于系统消息的补充判断

用户虽然之前对“系统消息太占空间”有反馈，
但这次更大的问题已经不是样式本身，
而是：
- 页面主语义错位
- 状态表达不可信

所以系统消息缩小仍然值得做，
但它不再是第一优先级。

真正第一优先级应改成：
1. active run source of truth
2. chat mode / run mode 显式化
3. run launch prompt 更 chat-first

## 建议下一会话先看
1. `docs/23_ACPX_PERMISSION_UI_AND_CHAT_POLISH_HANDOVER.md`
2. `docs/24_ACPX_CHAT_FIRST_CONTROL_AND_SESSION_MODE_HANDOVER.md`
3. `src/app/tasks/[id]/chat/page.tsx`
4. `src/app/api/tasks/[id]/control/route.ts`
5. `src/app/api/tasks/[id]/execute/route.ts`
6. `src/lib/task-room.ts`
7. `src/lib/acpx/runner.ts`

## 一句话结论
当前 task room 最大的问题，已经不是单个按钮或单条消息卡片样式，
而是：
- “正在浏览哪条 run”
- “正在控制哪条 run”
- “是否还没开始执行，只是在聊天”

这三件事没有被产品层清晰地区分。

下一阶段必须先把：
- active run
- selected run
- chat mode
- run mode

这四个概念真正拆开，
否则继续补丁只会让页面更像一个半聊天、半控制、半历史查看的混合体。
