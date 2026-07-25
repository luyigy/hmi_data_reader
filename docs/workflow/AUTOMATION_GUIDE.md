# 工作流自动化接入指南

## 目的

本仓库使用 PLAN、HANDOVER 和机器可读合同维护连续开发上下文。

外部自动化可以定期扫描已提交的工作流文档，并根据文档状态：

- 通知用户；
- 提取下一任务 Prompt；
- 启动可用 Agent；
- 或等待人工批准和验收。

本指南不规定必须使用 Hermes、Cursor、Claude、TRAE 或其他特定工具。

## 权威规则

自动化必须读取：

`docs/workflow/workflow-contract.yaml`

不得在 watcher、cron、CI 或 Agent Skill 中维护另一套 action、Prompt、目录或
legacy 规则。

validator 和 watcher 中可以保留校验算法，但文件名、控制字段、状态、动作、
Prompt 标记、编号与阈值的具体值必须在运行时从目标提交中的合同读取。

## 基本处理流程

自动化每次运行时：

1. 获取目标分支最新的已提交内容；
2. 读取工作流合同；
3. 定位合同指定的分支文档空间；
4. 找出尚未处理的 PLAN/HANDOVER；
5. 解析 YAML frontmatter；
6. 根据 `next_action` 判断：
   - 启动或准备下一任务；
   - 只通知；
   - 停止并等待人工操作；
7. 仅使用合同定义的 Prompt 标记提取 Prompt；
8. 对可执行 action 保存 `pending`，等待旧 Session 的最终回复完成标记；
9. 标记精确匹配后才记录 claim、重置 Session 并投递 Prompt；
10. 记录已处理事件，避免重复执行。

## 最终回复完成标记

创建可执行 PLAN/HANDOVER 的 Agent 必须：

1. 提交文档并取得该文档最后一次变更的完整 commit SHA；
2. 完成所有收尾工作；
3. 把合同 `completion_gate.marker_template` 展开后的文本作为最终回复最后一行：

```text
WORKFLOW_READY <document_commit_full_sha> <document_basename>
```

watcher 必须同时精确匹配完整 SHA、完整文件名、Agent Platform 发送者和最终回复消息
类型。只看到文档 commit、部分标记、错误发送者或工具过程消息时继续等待，不得 reset。
等待超时只告警并保留 `pending`，不能用固定延迟代替完成信号。

## 安全要求

自动化必须：

- 只读取已提交 Git 内容；
- 不消费工作区未提交文件；
- 不从自然语言标题或正文猜测下一步；
- 元数据无效时停止并报告；
- 不自动从 ROADMAP 创建下一阶段；
- 不重复处理同一个工作流事件；
- 可执行事件先持久化为 `pending`，完成标记出现后再 claim；
- terminal action 仍在通知前直接 claim，不等待完成标记。

建议使用以下组合标识事件：

`commit + document path + blob hash + next_action`

## 执行模式

### 通知模式

适用于 Cursor、TRAE 等没有稳定自动调用接口的环境。

自动化发现任务后：

- 输出或发送 Prompt；
- 通知用户；
- 用户把 Prompt 交给自己的编程助手。

### CLI 模式

适用于支持命令行启动的 Agent。

自动化发现任务后，调用用户配置的 CLI，并传入 Prompt。

具体命令由用户自己的环境决定。

### 服务模式

适用于 Hermes 或其他常驻 Agent 服务。

自动化通过 API、消息机器人或其他受控入口提交 Prompt。

### CI 模式

可以由 GitHub Actions、GitLab CI 或其他 CI：

- 检查新的工作流事件；
- 创建 Issue、评论或构建产物；
- 通知开发者；
- 调用可用的 Agent 服务。

## 调度方式

用户可以根据自己的环境选择：

- Linux cron；
- systemd timer；
- Windows Task Scheduler；
- GitHub Actions；
- GitLab CI；
- Jenkins；
- 常驻 watcher。

调度器只负责定期启动扫描程序，不应包含业务规则。

## 状态与日志

自动化应在仓库外保存：

- 已处理事件；
- 当前状态；
- 失败次数；
- 最后错误；
- 执行时间；
- 外部任务或 Session 标识。

不要把运行状态提交到业务仓库。

## 上线建议

按以下顺序启用：

1. 历史审计；
2. dry-run；
3. 只通知；
4. 单次受控执行；
5. 再启用定时任务。

启用前确认历史 PLAN/HANDOVER 不会被重新执行。

## 实现边界

仓库负责：

- AGENTS 规则；
- 工作流合同；
- PLAN/HANDOVER 文档；
- 自动化接入说明。

使用者负责：

- 选择调度器；
- 选择 Agent；
- 编写或配置适配代码；
- 保存运行状态；
- 配置通知渠道；
- 管理凭证和权限。
