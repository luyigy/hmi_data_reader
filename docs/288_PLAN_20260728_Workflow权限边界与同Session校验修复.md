---
doc_type: PLAN
doc_status: completed
next_action: none
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Workflow 权限边界与同 Session 校验修复

## 目标

把 Workflow 自动化的权限从“后台黑箱”改成用户可查看、管理员可在安全上限内设置、运行时可核对的
明确策略。自动化在项目 workdir 内应有完成编码、测试和联网所需的权限，不因普通权限卡阻塞；离开
workdir 后没有通用读写权限，必要的外部认证或配置只能作为公开列出的只读例外。

同时把 validator 定位为助推项：completion gate 优先把意见送回原 Session/thread，利用已有上下文
继续修订；修不好时明确通知并结束当前校验，不新建修复 Session、不无限重试，也不让 Session 卡在
等待态。机器可读文档未通过校验时，watcher 仍不得执行其下一动作。

## 用户最终能看到和控制什么

- `/ap workflow policy show`：查看 Workflow 权限，不需要启动新 Session。输出必须区分：
  - `configured`：管理员配置的策略及其权威来源；
  - `effective`：本次或下一次 Workflow 实际使用的 workdir、文件系统、网络和审批策略；
  - `enforcement`：Harness 的兑现等级，限定为 `applied`、`partially_applied` 或
    `recorded_only`，不能把“已记录”冒充“已隔离”；
  - `exceptions`：workspace 外允许只读访问的认证、配置、skills、plugins 或 rules 路径及原因。
- `/ap workflow policy set --preset=workspace`：仅管理员可设置系统支持的安全预设，并写入 watcher
  实际读取的同一权威配置，不维护第二份影子配置。命令返回变更前后值、操作者、审计记录和生效时机。
- 首版只实现 `workspace` 预设：项目 realpath workdir 可持久读写、隔离的临时目录可读写、网络启用、
  自动化无需普通运行时审批。任一 Harness 无法完整兑现时，启动前说明差异并拒绝静默降级。
- `/ap workflow policy set` 不能接受任意路径、任意 Full Access 或其他超出系统安全上限的参数。
  非管理员、非法预设和扩大边界的请求直接拒绝；聊天命令和普通权限卡都不是提权通道。

## 权限模型决策

- 启动时权限策略是不可突破的安全上限；运行时飞书权限卡只能批准该上限内的单次操作，不能修改
  `sandboxMode`、`networkAccess`、`writableRoots` 或 workspace 边界。
- Workflow 自动化使用项目 `workflow-watcher.config.execution_policy` 显式声明的策略，不继承 Room
  成员的 Full Access。workdir 始终从该项目的 `path` 实时解析，不在多处重复配置路径。
- `platform_local` Codex/Claude 依赖模型服务网络，因此 `workspace` 预设保持网络启用。网络启用意味着
  本 PLAN 保障的是文件系统隔离，不把它描述成完整的数据外泄防护。
- 保留网络隔离能力，但不新增当前 Harness 无法兑现的“双网络平面”抽象。断网策略只适用于离线 Harness
  或 adapter 已明确支持的场景；不兼容组合必须在启动前失败。
- Full Access 只通过独立管理员升级流程获得并要求新 Session；不属于本 PLAN 的 `/ap workflow policy
  set` 安全预设。

## 边界

- 复用现有 `AcpxPermissionConfig`、TaskRun interaction、Bubblewrap、workflow completion gate 和
  workflow watcher，不新增数据库状态机、repair 队列或第二套权限模型。
- 首版严格保障 `platform_local` Codex Workflow；其他 Harness 按现有
  `applied / partially_applied / recorded_only` 能力矩阵显式报告，不虚构已经生效的隔离或授权。
- 项目 realpath workdir 是唯一持久可写目录；不允许访问兄弟项目、宿主 `/tmp`、系统敏感目录、
  Docker socket 或额外可写根。沙箱内使用每次运行独立的 tmpfs `/tmp`。
- workspace 外默认不可见。Harness 必需的外部认证和共享配置只能逐项只读挂载，并在
  `/ap workflow policy show` 的 `exceptions` 中公开；需要持久化的 Harness 运行状态必须位于
  workdir 内的专用运行目录，且不得进入正常 Git 提交。
- 不修改目标业务仓库的测试布局或业务代码；本 PLAN 只改 Agent Platform。
- 不重启服务、不操作真实生产数据；每个 Slice 完成聚焦测试并提交后停止。

## S01：让权限可查看、可受控设置

**这一步做什么：** 增加 `/ap workflow policy show` 和仅管理员可用的
`/ap workflow policy set --preset=workspace`。为 `workflow-watcher` job 增加可校验的
`execution_policy`，命令和 watcher 共用同一权威配置；解析项目 `path` 的 realpath 后生成 TaskRun
权限快照，并在命令结果和 Workflow 卡片展示 `configured / effective / enforcement / exceptions`。

**完成标准：** 用户能看懂配置来源、实际权限、Harness 是否真的执行以及全部只读例外；管理员设置有
身份校验和审计记录。缺失、非法、越过安全上限或 Harness 无法兑现的配置在启动前明确失败，不回退到
Room Full Access，也不静默降级。

**这一步不做：** 不接入操作系统沙箱，不改变 validator 和权限卡。

## S02：把自动化关进项目 workspace

**这一步做什么：** 将 S01 的权限快照接入 Workflow 的 `platform_local` Codex 执行，复用现有
Bubblewrap 和非交互 JSON 路径。项目 realpath workdir 可正常读写、Git 和测试可运行、网络可用；
workspace 外没有通用访问权限，沙箱 `/tmp` 与宿主 `/tmp` 隔离，外部认证和配置只按公开清单只读挂载。

**完成标准：** 项目内写入成功；父目录、兄弟项目、系统敏感目录、Docker socket、宿主 `/tmp`、路径穿越
和符号链接逃逸均被操作系统级边界拦截；`policy show` 报告的 `effective / enforcement / exceptions`
与实际运行一致。

**这一步不做：** 不修改 validator 路由和权限卡生命周期。

## S03：让 validator 在原 Session 助推，不另开会话

**这一步做什么：** completion gate 把 validator 意见发回当前结果保存的原 session/thread id，最多自动
纠正两次；相同错误 fingerprint 再现时提前停止。删除 watcher 为 validator 错误派发
`PLAN_VALIDATE_REPAIR` 或其他新 Session 的路径；watcher 只通知、按 blob 幂等记录，并在新 commit 后复验。

**完成标准：** validator 失败不会创建或重置 Session，不会让原 Session 卡在 `waiting_for_input`；原
Session 可用时在同一上下文继续修订。原 Session 已结束或无法恢复时，只向 Task Room 发出包含完整错误的
通知并结束本次 gate，不创建替代 Session。未通过校验的机器可读文档不会触发下一 Workflow 动作。

**这一步不做：** 不改变文件系统沙箱和权限卡。

## S04：限制权限卡只能批准边界内的单次操作

**这一步做什么：** 统一普通 permission card 与管理员升级流程的语义和展示。卡片显示命令、当前
workdir 边界、授权范围和有效期；只批准启动策略安全上限内的本次操作。越界操作由沙箱直接拒绝，不发送
看似可以放行的权限卡。

**完成标准：** 普通卡不能修改 Workflow policy、不能授予 Full Access、不能越出 workspace。Session
停止、重置、超时或被替代时，pending interaction 立即变为 `cancelled` 或 `expired`，旧卡不能恢复
已结束进程。Codex 保留真实的 in-process 批准；其他 Harness 只展示 adapter 确实支持的能力。

**这一步不做：** 不新增第二套审批状态机或 repair 队列。

## S05：用真实流程验收并交接

**这一步做什么：** 用隔离测试项目走完 `/ap` 查看与设置、Workflow 启动、项目内工作、越界拦截、
validator 同 Session 纠正、原 Session 不可用时降级通知和旧权限卡失效的完整流程。

**完成标准：** 云端模型可完成对话和网络请求，项目内可写，workspace 外除公开只读例外外不可访问，
宿主 `/tmp` 不可访问；非管理员/非法预设被拒绝，配置与实际执行一致；validator 不新建 Session 且最多
纠正两次；旧权限卡不可继续。运行相关聚焦测试、TypeScript、ESLint、long-file guard、
`git diff --check` 和 GitNexus `detect_changes`，创建终态 HANDOVER；不重启服务。
