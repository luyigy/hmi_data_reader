# 25 ACPX One Click Agent Rights Escalation Handover

## 日期
2026-03-24

## 背景
在 `24_ACPX_CHAT_FIRST_CONTROL_AND_SESSION_MODE_HANDOVER.md` 落地后，task room 已经基本切到 chat-first：
- 无 active run 时，聊天模式可以直接继续旧 session 或拉起新 agent run
- 控制按钮只绑定 active run
- run prompt 也改成了当前对话优先

但真实使用中又暴露出一个新的高优先级问题：
- 用户已经能“和 agent 聊起来”
- 但一旦 agent 因权限或环境限制卡住，用户没有一个足够直接的“授权它继续”入口

用户明确要的是：
- 不想先理解 sandbox / approval / network 的细节
- 不想先保存配置，再自己决定 continuation / rerun
- 而是希望像 CLI 一样，更直接地说：
  - 给它更多权限
  - 继续刚才的对话

## 这轮真实暴露的问题

### 1. 从失败 run 继续聊天时，用户仍然缺一个“一键给权限再继续”的动作
当前虽然已经可以：
- 从 failed run 继续 Codex session
- 或从聊天模式直接拉起新 run

但用户面对 agent 明确说：
- 当前是 read-only
- network restricted
- 无法验证 loopback 服务

时，页面当前可用路径仍然过于间接：
- 打开权限设置
- 选择 profile
- 保存
- 再决定是 continuation 还是新 run

这对真实使用来说太绕。

### 2. 现在的权限 UI 仍然更像“配置面板”，不像“授权动作”
当前权限设置已经比之前轻了不少，
但它的主心智仍然偏向：
- 配置 launch-time settings

而不是：
- 在 agent 卡住时，给用户一个立即授权 agent 继续的动作

用户要的不是更多说明文案，
而是一个明确的按钮，例如：
- `授予开发权限并继续`
- `授予完全权限并继续`

### 3. Codex CLI approval 兼容性必须继续按真实 CLI 来对齐
本轮再次确认了本机 `codex exec --help` 的真实参数：
- 支持 `--full-auto`
- 支持 `--dangerously-bypass-approvals-and-sandbox`
- 当前帮助信息里并没有旧版 `--ask-for-approval`

因此后续如果再出现 approval 相关异常，
不能再按旧参数心智去修，
而必须始终以当前本机 CLI help 为准。

## 当前更准确的产品判断

### 1. “权限设置”与“授权 agent 继续”应该是两层能力
应该区分：

#### A. 详细配置
用于：
- 显式编辑 sandbox / network / approval / writable roots
- 调整下次 run / continuation 的默认权限

#### B. 一键授权动作
用于：
- agent 已经因为权限受限而卡住
- 用户只想快速放宽权限并继续

这两者不应该混成同一个入口。

### 2. 最短路径应该优先服务聊天流，而不是配置流
对 chat-first task room 来说，
用户面对受限 agent 时最短动作应该是：
1. 点“授予开发权限并继续”或“授予完全权限并继续”
2. 平台保存新权限配置
3. 平台自动 continuation 或自动启动新的 agent run

而不是：
1. 打开设置
2. 选 profile
3. 保存
4. 关闭设置
5. 再自己决定怎么恢复对话

### 3. 这类动作应该出现在用户最需要它的地方
更合理的位置包括：
- harness request 卡片里
- composer 上方或下方的快捷授权条
- selected failed run 的摘要附近

而不是只藏在权限面板内部。

## 推荐实施方向

### Phase 1. 新增一键授权动作
建议先做两个动作：
- `授予开发权限并继续`
- `授予完全权限并继续`

行为：
- 直接把 task 的 `acpxPermissionConfig` 更新为对应 profile
- 若当前可 continuation，则自动继续同一个 Codex session
- 否则自动以 chat-first 方式拉起新 run

### Phase 2. 对文案说人话
不要只写：
- `Safe Local`
- `Dev Local`
- `Full Access`

还要明确解释：
- 开发权限：允许写工作区、允许联网、必要时自动继续
- 完全权限：关闭 sandbox，适合已知外部环境已隔离的场景

### Phase 3. 继续把 Codex CLI 参数映射保持真实
后续任何 approval / sandbox 问题都必须：
- 先看本机 `codex exec --help`
- 再修 ACPX 映射逻辑

不要再按历史参数名或过期假设修复。

## 一句话结论
chat-first 已经打通了“先聊再做”，
下一步真正需要补上的，是：
- 当 agent 因权限受限卡住时，
- 用户可以一键给它更多权限，
- 并让它直接继续刚才的会话，

而不是被迫先绕回配置流。
