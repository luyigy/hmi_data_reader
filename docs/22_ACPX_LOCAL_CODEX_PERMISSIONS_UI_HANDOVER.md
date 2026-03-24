# 22 ACPX Local Codex Permissions UI Handover

## 日期
2026-03-24

## 目的
这份 handover 用于承接一个新的、已经被真实用户验证出来的需求：

- local Codex continuation 已经能确认“同一 session”
- 但 local Codex harness 在 ACPX platform 中仍然受到明显权限限制
- 尤其是：
  - localhost / 127.0.0.1 网络访问受限
  - 文件系统权限受 sandbox 模式限制
  - 当前 approval / permission 还不是可交互模式

因此下一阶段需要思考和实现的是：
- 能不能给 task room / Platform Local 增加一套可控的权限 UI
- 让用户能够在启动 local Codex run 前，明确配置：
  - sandbox mode
  - network access
  - approval policy
  - writable roots

## 当前已确认的事实

### 1. continuation session tracking 已经成立
用户已在真实测试中看到：
- `same Codex session confirmed · 019d1f54-5443-7d30-822f-38577b35d39f`

这说明当前 continuation tracking 已经不是理论设计，而是已有可见结果。

当前平台已经具备：
- 保存 `codexThreadId`
- continuation run 记录 lineage metadata
- 对 continuation run 做 `sameSessionConfirmed`
- 在 chat 页展示确认状态

因此下一步不必再优先怀疑：
- “这是不是其实是新 session”

当前更真实的痛点已经转移到：
- 权限配置不足

### 2. local Codex 在 ACPX 中确实感知到了网络/权限限制
用户反馈的 Codex harness 原话已经说明：
- 当前会话里无法访问 `127.0.0.1`
- 文件系统在某些 continuation 场景下也会表现出更受限的语义
- 它明确建议从这些维度配置：
  - `sandbox_mode`
  - `network_access`
  - `approval_policy`
  - `writable_roots`

这条反馈不应该被当成“模型幻觉”直接忽略。
因为它与我们当前代码状态是高度吻合的：

- ACPX local Codex 当前确实只显式配置了一部分 sandbox 行为
- 也还没有一个完整的、用户可视的 permission configuration UI
- 也还没有真正的 harness-native approval flow

### 3. 当前产品缺口不是“是否允许给权限”，而是“权限控制没有产品化”
平台并不是完全没有权限控制能力。

现在的问题是：
- 权限控制还停留在启动参数 / env / 代码层
- 还没有变成 task room 中清晰、诚实、可切换的 UI

因此用户现在虽然知道：
- 想要更高权限，需要放宽 sandbox / network / approval

但仍然做不到：
- 在 UI 上直观地配置它
- 明确知道这个 run 用的到底是哪组权限
- 知道 continuation run 是否沿用了同一组权限配置

## 当前代码状态与含义

### 1. local Codex sandbox mode 已开始可配置，但还不是 UI 化
当前代码已经开始朝这个方向迈出一步：
- 增加了 `ACPX_CODEX_SANDBOX_MODE`
- initial exec 与 resume exec 都会参考该配置

这意味着：
- 权限策略已经不再完全写死
- 但配置入口还只是 env / 启动层，不是 UI

### 2. network access 目前还没有 ACPX UI 层的显式模型
当前没有一个明确的 ACPX task-room-level 配置项告诉系统：
- 这个 local Codex run 是否允许联网
- 是否允许访问 localhost
- 是否允许 web search

这会带来两个问题：
- 用户无法在 run 前清楚决定权限
- harness 报“我被限制了”时，平台也没有地方把这个限制诚实展示出来

### 3. approval policy 仍不是原生可交互产品能力
目前的 allow / deny / explain 还更接近：
- 模板消息
- 下一轮再处理

而不是：
- harness-native permission approval
- 当前 session 中的真实审批

所以如果要做“权限 UI”，不能把它误解成：
- 只是再加几个按钮

更准确地说，需要分两层：

#### A. run launch permissions
- run 启动前决定这次 local Codex 有哪些基础权限

#### B. in-session approvals
- 当 harness 在执行中需要额外权限时
- 用户能否在当前会话里批准

当前更适合优先做的是 A，不是 B。

## 下一阶段应该怎么定义这个功能

### 核心目标
把 local Codex 的权限控制从“隐含的启动参数”变成“任务房间里可见、可改、可追踪的运行配置”。

不要把目标说成模糊的“让 agent 权限更大”。

更准确的目标应是：
- 用户能在启动 local Codex run 前清楚看到权限配置
- 用户能按场景切换安全级别
- continuation run 会继承或明确覆盖这组配置
- 页面中能看出当前 run 用了什么权限

## 推荐权限模型

### 1. 先做 launch-time profile，而不是一堆散乱开关
不建议一上来就直接把十几个底层参数全裸露给用户。

更合理的第一版是：
- 提供几个权限 profile
- 再提供一个“高级设置”展开更多细项

建议第一版预设 profile：

#### Safe Local
- `sandbox_mode: workspace-write`
- `network_access: restricted`
- `approval_policy: never`

适合：
- 只改当前仓库代码
- 不需要联网
- 风险最低

#### Dev Local
- `sandbox_mode: workspace-write`
- `network_access: enabled`
- `approval_policy: on-request`
- 可选 `writable_roots`

适合：
- 需要访问 localhost 服务
- 需要读写几个模型/缓存目录
- 仍希望保留一定安全边界

#### Full Access
- `sandbox_mode: danger-full-access`
- `network_access: enabled`
- `approval_policy: on-request`

适合：
- 强开发/强调试场景
- 用户明确愿意承担更高风险

第一版先用 profile，会比“几十个输入框”更容易让用户理解。

### 2. 高级设置再暴露底层参数
在 profile 之外，可提供“高级设置”面板。

建议暴露的字段：
- `sandbox_mode`
- `network_access`
- `approval_policy`
- `writable_roots`

其中：

#### sandbox_mode
建议选项：
- `read-only`
- `workspace-write`
- `danger-full-access`

#### network_access
建议选项：
- `restricted`
- `enabled`

后续如果需要，可再细分：
- `localhost-only`
- `internet-enabled`

但不建议第一版一开始就过度细化。

#### approval_policy
建议选项：
- `never`
- `on-request`

第一版不建议先支持太多中间态，避免语义复杂化。

#### writable_roots
建议以列表形式管理：
- 当前 repo 默认工作目录
- 用户可附加额外路径

例如：
- `/data1/ai-services/deepseek_ocr`
- `/data/cache/modelscope`
- `/tmp`

### 3. continuation 必须显式继承权限配置
如果只给“新 run”配置权限，而 continuation run 不记录这件事，会很快再次失真。

因此必须做的一件事是：
- 当用户在某个 run 上继续当前 Codex session
- continuation run 要么继承同一份 permission config
- 要么明确显示“这次 continuation 使用了不同权限”

这意味着 permission config 应写入：
- run metadata
- participant metadata

建议字段：
- `permissionProfile`
- `sandboxMode`
- `networkAccess`
- `approvalPolicy`
- `writableRoots`
- `inheritedFromRunId`

## 推荐 UI 放置位置

### 方案 A. 放在 `/tasks/[id]/chat` composer 上方
优点：
- 离“开始运行 / 继续对话”最近
- 用户很容易理解这是本次聊天/运行的权限

建议形态：
- 一排轻量 pills
  - `Sandbox: workspace-write`
  - `Network: restricted`
  - `Approval: never`
- 旁边一个：
  - `权限设置`

点开后出现 drawer / popover。

### 方案 B. 放在右侧 sidebar 的 run controls 区域
优点：
- 不挤压 composer
- 更像“运行配置”

缺点：
- 用户可能不容易意识到它会影响下一条消息触发的新 run

### 当前建议
第一版建议：
- 主展示在 composer 附近
- 详细编辑用 drawer / modal

理由：
- 这个功能与“发送消息后要怎样运行 agent”强相关
- 放得太远会削弱可发现性

## 推荐交互流

### Flow 1. 启动新 local Codex run
1. 用户在 chat 页选择目标 participant
2. 用户看到当前权限 profile pills
3. 若需要，打开“权限设置”
4. 修改 profile 或高级设置
5. 点击发送 / 开始运行
6. 平台把该 permission config 写入即将创建的 run metadata

### Flow 2. continuation run
1. 用户选中一个 historical run
2. UI 显示：
   - 该 run 的 session tracking
   - 该 run 的 permission profile
3. 用户点击继续当前对话
4. continuation 默认继承原 run 权限
5. 若用户修改权限，UI 明确提示：
   - “这会影响下一次 continuation run 的权限配置”
6. 新 continuation run 记录：
   - 继承来源
   - 实际生效权限

### Flow 3. harness 报权限不足
若 harness 明确报告：
- 网络被限制
- 文件系统只读
- 需要 approval

UI 应至少给出轻量建议：
- 当前 run 权限配置较保守
- 可在下一次 run / continuation 前放宽：
  - network
  - sandbox
  - approval

注意：
- 第一版先不要承诺“原地热切换权限”
- 更诚实的说法应是：
  - 新权限会在下一次 run / continuation 生效

## 实施优先级建议

### P0. 先把 permission config 数据模型接进 run metadata
这是第一步。

至少要做到：
- local Codex 启动时写入：
  - `permissionProfile`
  - `sandboxMode`
  - `networkAccess`
  - `approvalPolicy`
  - `writableRoots`
- continuation run 也写入同样字段

如果这层没落地，UI 只会是空壳。

### P1. 先做 launch-time permissions UI
第一版最值得先做的是：
- 新 run / continuation run 的权限设置面板

先不要试图一口气做：
- 当前 run 执行中动态调权
- 原生 approval bridge

### P2. 在 chat 页明显展示当前 run 权限
这一步很重要，因为用户必须能一眼看出：
- 现在这条 continuation 用的是什么权限

建议至少展示：
- sandbox
- network
- approval

### P3. 把 harness 的权限抱怨和 UI 配置联动起来
如果 harness 报：
- 只读
- 无法访问 localhost
- 需要 approval

UI 可以显示轻量提示：
- 当前 permission profile 可能过于保守

### P4. 再考虑真正的 interactive approval flow
这一步更难。

目标不是简单把 allow / deny 文案再做漂亮，而是：
- 当前 session 中真正处理 approval request

但这一步不应抢在 launch-time permissions 前面。

## 风险与注意点

### 1. 不要默认把权限放到 Full Access
即使技术上能做，也不应把最危险模式设为默认值。

建议默认：
- `workspace-write`
- `restricted` network
- `never` 或较保守 approval

然后由用户显式切换。

### 2. continuation 与 permission inheritance 必须诚实
不要让用户误以为：
- “我改了 UI 上的权限，这个正在跑的旧 turn 马上就会获得新权限”

更诚实的规则应是：
- 新权限只对下一次新 run / continuation 生效

### 3. writable roots 需要做校验
用户输入路径时，建议做最小校验：
- 非空
- 绝对路径
- 去重

并且最好避免：
- 不小心把系统关键目录全暴露

### 4. localhost 访问应作为一个明确用户心智
从这次真实问题看，localhost access 是一个高频需求。

因此 network UI 不应只抽象成“能不能联网”，
还应在说明文案里明确举例：
- 访问 `127.0.0.1`
- 访问本机模型服务
- 调试本地 API

## 建议下一会话先读
1. `docs/21_ACPX_TASK_ROOM_CONTINUATION_PLAN_HANDOVER.md`
2. `docs/22_ACPX_LOCAL_CODEX_PERMISSIONS_UI_HANDOVER.md`
3. `src/lib/real-agents/codex-agent.ts`
4. `src/lib/acpx/runner.ts`
5. `src/app/api/tasks/[id]/control/route.ts`
6. `src/app/tasks/[id]/chat/page.tsx`

## 一句话结论
当前 local Codex 的 continuation session 已基本可信；
下一阶段最值得做的不是再证明 session continuity，而是把 local Codex 的权限配置正式产品化成可见、可调、可继承的 UI。
