# 验收运行目录的归档与清理

验收运行目录位于 `TASK_GRAPH_VALIDATION_ROOT` 或 `~/.agent-platform/task-validation/<node 摘要>/<attempt 摘要>`。每轮验收保存独立报告；这里不是代码 worktree，也不是项目虚拟环境。

## 完成后的行为

节点只有在 `passed` 或 `delivered_unverified`，且实施、问答、架构、验收均没有 pending/running TaskRun 时，才进入清理。后者仍表示仅实施交付，清理不改变验收结论。

1. 原有工作区清理保留提交与交付产物，检查脏文件与集成关系。
2. 所有仓内任务完成上述清理后，平台在仓库锁内归档本节点的全部验收轮次。
3. 文件保存到首个执行仓库旁的 `.agent-platform-task-graph-results/<run 摘要>/validation/<node 摘要>/files/`，相对路径保留 attempt 目录。
4. `manifest.json` 记录原目录、节点、文件相对路径、大小与 SHA-256。目录内部的符号链接记录原 target 与解析后的相对目标，不跟随复制、不在归档中重建链接；查阅 pytest 的 current 别名时按清单定位实际目录。文件复制及哈希核验成功、再次确认无活跃 TaskRun、源文件未变化后，才删除本节点临时验收目录。
5. `validation_workspace_cleaned` 事件记录归档位置、文件数与字节数。子任务只读问答自动挂载该归档，并提示通过 manifest 定位旧报告路径。

`node_modules`、`.venv`、`venv`、Python 缓存、pytest/mypy/ruff 缓存和 `.cache` 目录不归档。它们只是验收运行目录中的临时缓存，源项目环境和输入图片目录不在本次删除范围。归档总量上限为 256 MiB、10,000 个普通文件。

## 中断和失败

- 没有达到完成状态或仍有活跃会话时，保留目录。
- 指向目录外或无法解析的符号链接、特殊文件、超过上限、归档内容不一致或源文件变化时，保留源目录并记录 `validation_workspace_cleanup_deferred`，不猜测可删除范围。
- 重复清理在同一锁和事件键下执行。源目录已删除但事件尚未写入时，重新核对现有 manifest 和归档文件，不覆盖其他内容。
- 已标记 `node_workspaces_cleaned` 的旧节点仍检查新的验收清理回执，因此可以补清历史遗漏。
- 无法归档的节点需要核对原因后重试；未知孤立目录不在扫描删除范围。

## 与后继任务代码输入的区别

这里归档的是测试报告、截图、驱动和读回数据，不解决跨仓源码派发。前置节点完成只代表调度条件满足，不意味着后继沙箱自然能读取另一仓库。

真实业务 S06 属于 mold 仓，R02A/R02B 属于 Reader。Reader 临时 worktree 完成后已清理，代码仍在 Reader Git 集成分支；S06 的派发没有提供对应的固定提交源码及合同输入，因此可见 Reader 路径只有少量挂载目录。应另行补齐从前置执行账本生成固定提交/合同输入并只读提供给后继的流程；不能把 S06 的 cwd 改到 Reader，也不能让后继读源仓任意 HEAD。本次只修报告归档清理，未修改 S06 状态或新增跨仓代码输入。
