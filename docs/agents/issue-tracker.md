# Issue tracker: Gitee

本项目新工作的 Spec 与 Slice tickets 发布到 Gitee 仓库 `luyi1678/agent-platform-v2`。用户于 2026-10-17 指定改用 Gitee，以便在当前网络与登录环境打开和操作。Matt 的 `to-spec`、`to-tickets` 和相关工程 skills 使用此配置。

GitHub `luyigy/agent-platform-v2` 已发布的工作流 Spec 与五张 tickets 保留作历史参考，本轮不再从它们调度。不得同时把两边当成实时任务来源；本次未关闭或修改 GitHub 旧单。

## 目标与认证

- 每条 Issue 命令指定 `--hostname gitee.com -R luyi1678/agent-platform-v2 --no-tui`，不从多个 Git remote 猜测仓库。
- 用 `gitee auth status --json` 检查 API 登录态。Git SSH/HTTPS 推拉认证不代表 Issues API 已登录；仅在现有 API 认证确实失效时要求重新登录。
- 凭据由 CLI 保管，不写入仓库、命令正文、Issue 或证据日志。
- Issue ID 是字符串，完整保留字母数字编号。跨仓引用使用 `gitee:<owner>/<repo>#<issue-id>`；兼容外部 GitHub 时使用相应 provider 的全限定引用。
- 创建、评论、编辑、关闭是外部写入，须有用户任务授权。创建 tickets 不等于批准实施，`ready-for-agent` 不代替飞书执行审批。

## Issue 操作

- 列表：`gitee issue list --hostname gitee.com -R luyi1678/agent-platform-v2 --no-tui -s open --json=number,title,state,labels,assignee`。
- 读取：`gitee issue view <issue-id> --hostname gitee.com -R luyi1678/agent-platform-v2 --no-tui --json=number,title,body,state,labels,assignee`。
- 创建：`gitee issue create --hostname gitee.com -R luyi1678/agent-platform-v2 --no-tui -t "<title>" -b "<body>" --labels ready-for-agent --json`。多行正文通过结构化参数或脚本读取文件后传递，避免 shell 展开。
- 评论：`gitee issue comment <issue-id> --hostname gitee.com -R luyi1678/agent-platform-v2 --no-tui -b "<comment>"`。
- 编辑、修改标签、指派和关闭先读取 `gitee issue <command> --help`，只更新授权字段，保留无关标签及他人内容。
- 原始 API 使用 `gitee api /repos/luyi1678/agent-platform-v2/... --hostname gitee.com --no-tui`，认证由 CLI 注入。

“发布到 issue tracker”表示发布到上述 Gitee 仓库；“读取 ticket”表示按 Gitee 字符串编号读取。PR 不作为本项目的请求入口。

## Spec、子任务与阻塞关系

- `to-spec` 创建包含完整规格的父 Issue；`to-tickets` 按前置顺序创建独立子 Issue。每张子 Issue 的 Parent 指向父 Issue，Blocked by 提供可点击的完整 blocker 链接。
- 本轮使用正文受控注释块记录关系，不声称 Gitee 原生提供 GitHub 同款 blocked-by 或 sub-issue API。
- 注释格式为 `<!-- ap-ticket-v1 {JSON} -->`。JSON 包含 `version: 1`、稳定的 `project`、`sliceKey`、全限定 `parent` 和全限定引用数组 `blockedBy`。父 Spec 的 parent 为 null。
- 每张单据另有稳定发布标记。写入前检查标记与同名条目；超时先对账，再恢复，不能盲目重复创建。
- 引用和依赖须读取真实 Issues 后解析、校验；缺失、歧义、版本错误或循环阻塞应报错，不能从自然语言推测。读取后生成的关系图和本地索引是投影，不是第二编写源。
- 规划 frontier 为未领取且没有未完成前置的子任务。实际执行仍以飞书批准的快照及账本完成条件放行，远端 Issue 关闭不能替代验收和集成。
- 完成后按批准模式写入交付证据，再幂等回写 tracker。仅实施模式必须明确“未验收”，不得把关闭单据解释为已通过全部检查。

## Wayfinder

Wayfinder 决策地图与实施 tickets 分开：地图 Issue 列出目标、已决事项及待澄清问题；决策子 Issue 标明 research/prototype/grilling/task 类型和父地图。跨决策阻塞复用上述受控字段。若类型标签尚不存在，先核实命令与授权后创建，不依赖自然语言标签推断执行状态。

## 本轮实际包

工作流收敛包位于 `docs/specs/workflow-convergence/`。索引列出真实 Gitee Spec 与五张 Slice 的链接；GitHub 的上一版发布可在历史记录中追溯。当前运行时的从 Issues 提审与自动派发能力仍由该包的 W3/W4 实现，不因配置切换就宣称已具备。
