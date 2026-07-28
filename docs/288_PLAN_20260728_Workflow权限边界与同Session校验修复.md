---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Workflow 权限边界与同 Session 校验修复

## 目标

让自动化 Workflow 在保持 Codex/Claude 等云端 Harness 正常联网的同时，只能修改项目配置的
workdir；自动化不等待运行时权限卡，completion gate 在原 Session 内反馈并修复工作流文档，
watcher 只观察、通知和复验，不再为 validator 错误重置或新建修复 Session。

## 权限模型决策

- 启动时权限策略是不可突破的安全上限；运行时飞书权限卡只能批准该上限内的单次操作，不能修改
  `sandboxMode`、`networkAccess` 或 `writableRoots`。
- Workflow 自动化使用项目 `workflow-watcher.config.execution_policy` 显式声明的策略，不继承 Room
  成员的 Full Access。首版只允许 `filesystem: project_workdir`、`network: enabled`、
  `approval: never`；workdir 始终从该项目的 `path` 实时解析，不在多处重复配置路径。
- 保留网络隔离能力，但 `safe_local` 不再作为云端 Harness 的通用默认模式。对依赖模型服务网络的
  `platform_local` Codex/Claude，断网配置必须显示为不兼容并在启动前失败；仅离线 Harness 或明确
  支持“模型控制面联网、工具数据面断网”的 adapter 才可使用网络隔离。现阶段不新增无法兑现的
  双网络平面抽象。
- Full Access 只通过独立管理员升级流程获得，并要求新 Session；普通 permission card 不得升级为
  Full Access，也不得让命令越出 workdir。

## 边界

- 复用现有 `AcpxPermissionConfig`、TaskRun interaction、Bubblewrap、workflow completion gate 和
  workflow watcher，不新增数据库状态机、repair 队列或第二套权限模型。
- 首版严格保障 `platform_local` Codex Workflow；其他 Harness 按现有
  `applied / partially_applied / recorded_only` 能力矩阵显式报告，不虚构已经生效的隔离或授权。
- 网络保持启用；不允许自动化访问兄弟项目、宿主 `/tmp`、系统目录、Docker socket 或额外可写根。
  沙箱内可保留独立 tmpfs `/tmp` 供测试运行时临时数据使用。
- 外部认证和共享配置只读挂载；需要持久化的 Harness 运行状态必须位于项目 workdir 内的专用运行目录，
  且不得进入正常 Git 提交。
- 不修改目标业务仓库的测试布局或业务代码；本 PLAN 只改 Agent Platform。
- 不重启服务、不操作真实生产数据；每个 Slice 完成聚焦测试并提交后停止。

## S01：显式 Workflow 执行策略与 Safe Local 语义

为 `workflow-watcher` job 增加可校验、可展示的 `execution_policy` 配置，首版只接受
`project_workdir + network enabled + approval never`。解析结果必须使用项目 `path` 的 realpath，
并作为 TaskRun 的权限快照和 Workflow 卡片可见信息；缺失或非法配置启动前失败，不回退 Room 权限。
同步梳理 Harness 能力矩阵：云端 Harness 拒绝无法完成模型连接的 `safe_local` 断网组合，离线能力继续
保留；不在 helper 中硬编码隐藏策略。

## S02：Workdir 操作系统级隔离

将 S01 权限快照接入 Workflow 的 `platform_local` Codex 执行，复用现有非交互 JSON 路径和 Bubblewrap：
只把项目 workdir 读写绑定，启用网络，宿主 `/tmp` 与其他目录不可写。收紧 Codex Home/共享配置挂载：
外部认证、配置、skills、plugins 和 rules 只读；可写运行状态位于 workdir 内专用目录。覆盖路径 realpath、
父目录逃逸、符号链接逃逸、宿主 `/tmp` 隔离、网络可用和项目内 Git/测试写入。

## S03：原 Session Completion Gate 与只读 Watcher

删除 workflow watcher 在 validator 失败时派发 `PLAN_VALIDATE_REPAIR` 新 Session 的行为；保留完整错误通知、
同 blob 幂等和新 commit 自动复验。确认 completion gate 继续使用当前结果中的 session/thread id 续接原
Harness，最多自动纠错两次。补回归测试：validator 错误不会调用 `new-session`、不会中断
`waiting_for_input`，纠错复用原 Session，修复提交后 watcher 正常进入后续 gate。

## S04：飞书运行时权限卡边界与生命周期

统一普通 permission card 与管理员权限升级的语义和展示：卡片显示命令、当前 workdir 边界、授权只对本次
操作有效且不扩大权限。越界操作由沙箱直接拒绝，不发送可越权卡；Session 停止、重置、超时或被替代时，
所有 pending interaction 立即变为 `cancelled` 或 `expired`，旧卡不可恢复已结束进程。Codex 保留
in-process 批准；其他 Harness 仅按真实 adapter 能力使用 continuation，并明确标记非等价支持。

## S05：集成验证与交接

运行 workflow watcher/completion gate、权限解析、Bubblewrap、Codex approval、Live Room 聚焦测试，
TypeScript、相关 ESLint、long-file guard、`git diff --check` 和 GitNexus `detect_changes`。使用隔离测试
项目验收：云端模型可完成对话、网络请求可用、项目内写入成功、workdir 外和宿主 `/tmp` 写入失败、
validator 原 Session 自动纠错、旧权限卡不可继续。创建终态 HANDOVER；不重启服务。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md` 的 S01：只实现显式 Workflow
`execution_policy` 配置、解析校验、TaskRun/Workflow 卡片权限快照，以及 `safe_local` 对云端与离线
Harness 的兼容性判定。先读取 `docs/workflow/workflow-contract.yaml`、本 PLAN、最新有效 HANDOVER、
`config/projects.yaml`、ACPX 权限类型/能力矩阵和 scheduled job 配置入口；对将修改的每个 symbol 先运行
GitNexus upstream impact，HIGH/CRITICAL 先报告。不得开始 S02，不接入 Bubblewrap，不改变 watcher
validator 派发或 permission card 行为，不修改目标业务仓库。完成聚焦测试、TypeScript、相关 ESLint、
long-file guard、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S01 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
