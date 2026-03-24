# 23 ACPX Permission UI And Chat Polish Handover

## 日期
2026-03-24

## 目的
这份 handover 用于承接在 ACPX task room 中新增“权限设置 UI”后的第一轮真实用户反馈。

当前已经不是纸上设计阶段，而是已经有真实测试暴露出一组非常明确的问题：
- 权限设置保存后没有真正生效
- 当前进行中的 session 不能通过这个 UI 热切换权限
- 权限设置组件放在对话区上方，明显抢占聊天空间
- 当前权限模型过于绑定 local Codex，不利于后续 Claude / 其他 harness 扩展
- 聊天历史里的系统消息字体过大、卡片感太重，继续挤压主区
- 在当前页面点击“开始运行”后，页面没有原地切到新的 run，需要退出再回来才看到

因此下一阶段不应继续只围绕“把更多开关堆进 UI”推进，而应转成：
- 修正当前权限实现的真实行为
- 重新整理权限 UI 的产品位置与抽象层次
- 继续收敛 chat 页空间分配与运行刷新逻辑

## 当前真实问题总结

### 1. “保存权限设置”当前没有形成真实可用闭环
用户实际测试中看到：
- 点击保存权限设置后报错
- 页面提示类似：
  - `Failed to update task`

同时用户又从 run failure 中看到更具体的 harness 错误：
- `unexpected argument '--ask-for-approval' found`

这说明当前这一版权限 UI 的问题不是“纯前端没保存”这么简单，
而更可能是：
- 后端确实试图把 approval config 带入 Codex CLI
- 但当前使用的 CLI 参数形式并不兼容现有 `codex exec` 调用方式
- 导致保存 / 运行后的实际链路没有按预期打通

下一步必须先把这类问题说清楚：
- 哪些 permission settings 只是“被存储了”
- 哪些 settings 已经“真实影响 harness 启动”

如果这层不澄清，UI 会继续制造误导。

### 2. 当前权限设置不会热切换已经进行中的 session
这一点用户已经明确问到，而且必须诚实对待。

当前产品真实语义应当明确为：
- 权限设置影响的是：
  - 下一次新 run
  - 或下一次 continuation run
- 它不会热切换当前正在执行的那个 busy turn
- 更不会在当前同一个运行中的子进程里瞬间刷新 sandbox / network / approval

所以用户现在感受到的“为什么保存了没立刻改变当前 agent 能力”，
并不是偶发现象，而是当前实现与真实运行模型不匹配导致的自然结果。

这件事下一步不能靠补一句 hint 糊过去，应该在产品层明确：
- 当前生效范围
- 何时生效
- 是否继承到 continuation

### 3. 权限设置组件的位置不对，明显挤压了聊天主区
用户反馈非常明确：
- 这个设置权限的组件不应该放在对话框上方
- 它现在过度占空间

从当前页面布局看，这个反馈是完全合理的。

因为 task room 这页的主目标已经被证明是：
- chat first

而不是：
- dashboard first
- settings first

把一个大块配置卡片放在 feed 上方，会直接带来两个问题：
- 消息历史区高度被继续压缩
- 用户视觉上会觉得“我又回到了配置页/控制台页”

下一版应该把权限设置从“主区永久展开卡片”收回到更轻的位置。

### 4. 当前权限抽象过于偏向 Codex，不利于后续 Claude / 其他 harness
用户明确指出：
- 现在这个设置为什么只针对 Codex
- 后面如果换 Claude 怎么办

这是一个非常关键的问题。

如果我们把权限 UI 的文案、逻辑、存储都直接命名成：
- `Local Codex 权限设置`

那后续很快会遇到几个扩展问题：
- local Claude 是否也要复制一套新 UI
- 不同 harness 能力不同，哪些字段是共通的，哪些字段是特有的
- task room 这页到底展示的是：
  - “某个 harness 的私有配置”
  - 还是“本次 direct local run 的通用执行权限”

下一步更合理的抽象方向应是：
- 先提升到 `Local Harness Permissions`
- 再在内部按 harness capability 做差异化

也就是说：
- UI 层抽象应尽量通用
- 具体某些字段是否生效，再由 harness capability 与 launcher 决定

### 5. 系统消息卡片过大，继续挤压聊天体验
用户指出：
- 当前对话消息历史框里的系统消息字体太大
- 占用太多空间

这是当前 chat 页继续向“真正聊天产品”收敛时必须处理的细节。

尤其像：
- `run_failed`
- `系统提示`
- `control_message`
- continuation notice

这些内容本质上都不应该比真正的用户消息 / assistant 回复更抢眼。

当前更合理的方向是：
- 系统消息字号更小
- padding 更薄
- 视觉更轻
- 尽量像轻量 status separator，而不是一张大卡片

### 6. 点击“开始运行”后没有在当前页面原地切换到新的 run
用户当前观察到：
- 在当前界面点击开始运行
- 需要退出当前页面再进入
- 才能看到新的 Run

这说明当前页面在“启动新 run 后自动切换 selectedRun”这件事上仍有缺口。

当前更合理的行为应该是：
- 点击开始运行
- 后端返回新的 run
- 页面立即刷新 run list
- 自动切到最新 run
- feed 原地开始显示新 run 的事件

如果这个闭环没做到，用户会觉得：
- 页面像是卡住了
- run history 没及时更新
- 必须靠手动重进页面修正状态

## 当前问题背后的更准确判断

### 1. 现在不是“权限 UI 不该做”，而是“权限 UI 不能先于真实权限行为”
当前最重要的结论不是：
- 这个方向错了

而是：
- UI 不能先走得比真实 launcher 行为更远

也就是说：
- 先定义清楚各项设置的真实可支持程度
- 再决定 UI 怎么展示“已生效 / 仅记录 / 尚未支持”

否则会继续出现：
- 用户保存了
- 但实际能力没变
- 最后只会削弱对整套 task room 的信任

### 2. “当前 session 是否热切换权限”必须被定义成产品规则，不是临时说明文案
这件事不能再放任用户猜。

下一版至少要在产品层明确分成两类：

#### A. Launch-time permissions
- 在启动新 run / continuation run 前决定
- 会影响新子进程

#### B. In-session approvals / escalation
- 当前 session 执行中额外请求权限
- 如果要做，必须是另一套能力

当前第一版明显只做到了 A 的一部分，
还没有做到 B。

所以必须明确告诉用户：
- 当前保存的是 launch-time settings
- 不是当前执行中进程的 live mutation

### 3. 权限 UI 的位置要服从 chat page 的主目标
chat 页现在最大的原则已经非常清楚：
- 主区优先服务聊天

因此权限设置更适合做成：
- pills + 按钮
- drawer / popover / modal
- 或右侧 sidebar 的一个折叠区

而不应做成：
- 主区上方常驻的大卡片

## 下一阶段推荐目标

### 核心目标
把当前这版“权限 UI 原型”推进到：
- 行为真实
- 作用范围诚实
- UI 不抢聊天空间
- 抽象不绑死 Codex
- 启动 run 后页面原地刷新

## 推荐实施计划

### Phase 1. 先把“哪些配置真的会生效”梳理清楚
这一阶段优先级最高。

目标：
- 列出当前 ACPX local harness launcher 真正支持的参数
- 明确区分：
  - 已真实应用
  - 仅保存到 metadata
  - 当前还不支持

至少要覆盖：
- `sandbox_mode`
- `approval_policy`
- `network_access`
- `writable_roots`

输出不应该只是代码注释，而应落实到：
- 运行 metadata
- UI 上的状态说明

例如：
- `sandbox: applied`
- `approval: partially applied`
- `network: recorded only`
- `writable_roots: recorded only`

### Phase 2. 把权限设置重新收纳到不抢空间的位置
建议下一版优先改为：
- composer 上方只保留轻量 pills
- 点击 `权限设置` 后打开：
  - modal
  - 或右侧 drawer

不要继续让权限面板默认展开在 feed 之上。

推荐形态：
- 轻量展示：
  - `Profile`
  - `Sandbox`
  - `Network`
  - `Approval`
- 详细设置：
  - 放进折叠面板或弹层

### Phase 3. 把权限模型抽象成 `Local Harness Permissions`
下一版不要继续把 UI 标题与逻辑直接写死成：
- `Local Codex 权限设置`

应改为更通用的抽象，例如：
- `Local Harness 权限设置`

然后针对具体 harness 做 capability 差异化：
- local Codex
- local Claude
- 未来其他 local harness

第一版不要求所有 harness 都完整支持，
但 UI / 数据模型应该避免再次被 Codex-only 绑死。

### Phase 4. 明确标注“仅对下一次 run / continuation 生效”
这一步用户价值很高，而且很容易落地。

至少要在 UI 中明确写清：
- 当前修改不会热切换正在运行的 turn
- 会在下一次新 run / continuation 时生效

如果当前 selected run 正在执行中，
更应该显示：
- `当前权限变更不会影响正在执行的 session`

### Phase 5. 把系统消息和控制事件进一步缩小、降噪
重点对象包括：
- `system` room message
- `control_message`
- `run_failed`
- `run_completed`
- `session_continuation_started`

推荐方向：
- 字号从当前继续下调
- padding 更紧
- 降低背景对比度
- 更像分隔信息条，而不是大块消息卡片

目标是：
- 用户消息 / assistant 回复始终是主角

### Phase 6. 修复“开始运行后页面不能原地切到新 run”
这是下一步非常值得马上补的体验问题。

可能需要排查的点包括：
- `handleExecuteTask()` 后是否及时 `fetchRuns()`
- `selectedRunId` 是否被更新到最新 run
- socket event 到达前，页面是否已有本地 optimistic 选择逻辑
- run history 列表更新后是否自动选中第一项

下一版目标应是：
- 用户点击开始运行后
- 当前页面自动切到新 run
- 不需要退出重进

### Phase 7. 再考虑 permission UI 与真实 approval flow 的长期合并
这一阶段不需要立刻做，但要留在视野里。

长期来看：
- launch-time permission settings
- in-session approval requests

这两者都和“权限”有关，
但不应该混成同一套假象交互。

更合理的长期设计应是：
- 先把 launch-time settings 做扎实
- 再把真实 approval flow 接回来

## 建议下一会话先看
1. `docs/22_ACPX_LOCAL_CODEX_PERMISSIONS_UI_HANDOVER.md`
2. `docs/23_ACPX_PERMISSION_UI_AND_CHAT_POLISH_HANDOVER.md`
3. `src/app/tasks/[id]/chat/page.tsx`
4. `src/app/api/tasks/[id]/execute/route.ts`
5. `src/app/api/tasks/[id]/control/route.ts`
6. `src/lib/real-agents/codex-agent.ts`
7. `src/lib/acpx/runner.ts`

## 一句话结论
当前权限 UI 已经证明“方向有价值”，
但它还只是第一版原型。

下一阶段真正该做的，不是继续加更多开关，
而是把：
- 生效语义
- UI 位置
- 抽象层级
- run 刷新体验
- 系统消息降噪

一起收口成更诚实、更聊天优先的一版。
