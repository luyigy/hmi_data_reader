<!-- 用法：把本文件内容并入目标仓库根 AGENTS.md（追加“工作流规则”一节），替换两处 [CHANGE-ME]。 -->

## 工作流规则

仅以下任务读取 `docs/workflow/workflow-contract.yaml`：PLAN、HANDOVER、文档编号、
workflow automation、validator/watcher。该合同是以上流程的唯一规则源；普通代码修改无需读取合同。

本仓库工作流由 agent-platform-v2 平台监测执行（扫描已提交文档、审批卡、Session 接力）。
<!-- [CHANGE-ME] 上句可补充本项目注册要点：ref、branch_space、自治模式、执行策略。 -->

约定：

- 创建或修复 PLAN/HANDOVER 时，必须读取合同声明的 PLAN 写作标准及
  <!-- [CHANGE-ME] 按本仓库 branch_spaces.root 调整下述文档目录前缀（如 docs/codex/<空间>/）。 -->
  `docs/workflow/templates/PLAN.md` 与 `docs/workflow/templates/HANDOVER.md`；
  缺失时报告未初始化，不回退到平台安装目录中的隐藏副本。
- <!-- [CHANGE-ME] 本仓库若有 workflow:new / workflow:validate npm 脚本，改为：
      “新建文档必须使用 `npm run workflow:new` 生成骨架，禁止手工创建结构；正文填写完成且
       `git add` 后必须运行 `npm run workflow:validate -- --preflight <文档路径>`。”
      没有脚本时保留下一行表述。 -->
  本仓库暂无 workflow:new / workflow:validate 脚本；新文档以模板为骨架手工创建，
  提交前用平台命令（`/ap workflow validate`，可用后）或对照模板逐项自查 frontmatter 与 Prompt 标记。
- 自动化只读取目标 Git ref 中已提交的文档，不消费工作区文件，也不从正文猜测动作。
- 可执行文档提交后，最终回复最后一行必须使用
  `WORKFLOW_READY <document_commit_full_sha> <document_basename>` 标记；
  合同 Prompt 标记之间的下一 Session Prompt 须原样附在最终回复中供直接复制。
- 长文件守卫：已达合同 `large_files.blocking_lines` 阈值的文件不得增长；
  需要新增职责时，先在同一提交中提取明确边界的模块。
- watcher 已启用后 Git 历史必须只追加：不 amend、不 rebase、不 reset、不强推；
  对同一文件的后续修正创建新的 commit。
