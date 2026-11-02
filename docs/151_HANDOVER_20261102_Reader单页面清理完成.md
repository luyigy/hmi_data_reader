---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: docs/150_PLAN_20261102_Reader单页面清理.md
slice: S01
plan_progress: complete
---

# Reader 单页面清理完成

## 用户授权与结果

用户授权先只清理 Reader，以 B&R 射胶保压页为唯一案例；明确要求清理前检查工作树以便回滚。mold 仓没有修改。本任务不恢复旧计划，不启动 DEMAG 或其他页面，不部署、不重启、不推送。

开工分支 `deploy/yizumi-auto-page`，工作区干净，基线 `1308f26e9189f35dfdd77c2cb81364b6d391437c`。
创建本地带注释标签 `backup/reader-before-page-cleanup-20261102` 固定原代码与测试。标签没有推送到远端。

现在只有一个活动页面 `b_and_r.injection_holding.multi_stage_position_time`。页面代码集中于 `scripts/extract_families/b_and_r/injection_holding/multi_stage_position_time/`；职责见该目录 README。专属测试集中于 `tests/pages/b_and_r.injection_holding.multi_stage_position_time/`。

## 清理边界

- 移除其他页面提取模块、活动模板、冻结页面包、专属原屏定义及相应能力测试。Git 标签保留原版本。
- B&R 温度、熔胶也退出当前运行支持。公共 OCR、分类候选、图像矫正、视觉/坐标原语、字段目录和公共 schema 保留。分类器仍认识其他控制器，不等于其页面支持仍存在。
- HTTP、CLI 共用路由与提取器；删除入口中的 TACT5、DEMAG、FANUC 等专用补读和旧模板别名、文件名回退。未支持页面不再执行通用字段提取，v1 保留 OCR 并返回拒识/空字段，v2 返回 422。
- 页面管理仍是公共能力；未登记实现的页面不能通过草稿创建重新启用。包导出也拒绝其他页面。
- 历史图片、标注、真值、训练数据与文档保留，不能把其中的历史成功报告当作当前支持清单。离线通用 VLM/实验工具仍可保留，但没有在线未知页参数提取入口。
- 删除 4 个引用已退役补读函数的探测工具，以及已失效的历史多页面/旧路径验收脚本；当前回放入口见下文。

## 版本与兼容变化

B&R v1 活动模板及已发布 B&R 包内容未修改，数值和段位行为保持原基线。
B&R v2 原 `0.6.0` 原文保留用于历史文档导出；移动后的源码记录为新 `0.6.1` 包和字段定义，校验当前 13 份源码/定义哈希。历史包不再要求旧源码路径仍存在，不调用其内嵌代码。当前 v2 观测始终引用新实现身份，不伪装成旧包。

mold 未增加 0.6.1 接纳；新包不应被宣称已经业务可用。绑定旧 0.6.0 的 v2 请求明确拒绝，不静默升级为新包。绑定旧包版本的调用方、启用态 unknown、未识读勾选仍须按现有规则处理。本片没有完成“无需人工核对的真实图片到 mold 标准参数”验收；没有修改 API 路径、数据库或业务保存。

## 实际验证

整理前：75 项 B&R 聚焦测试通过。

整理前后分别运行：

```bash
.venv/bin/python scripts/verify_b_and_r_stability.py --output /tmp/reader-cleanup-before
.venv/bin/python scripts/verify_b_and_r_stability.py --output /tmp/reader-cleanup-after
```

7 张历史照片的 131 个物理读数和对应状态与真值一致；results.json、matrix.json、model-inputs.json 三份完整 JSON 整理前后相等，涵盖字段、布局、状态及原图投影。它们使用冻结 OCR，不是新照片准确率或真实在线 OCR 测试。

最终套件：

```bash
PYTHONPATH=scripts:. PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest tests -q --tb=short
```

275 passed，12 skipped，22 subtests passed。3 条 FastAPI/Starlette 既有弃用警告。跳过项是显式环境条件下的 B&R 在线 OCR/跨仓证据测试，本片未跑 GPU、真实线上 HTTP、飞书发送或 mold 保存。最后一次完整套件为 275 passed；后续收紧注册模板入口并刷新源码包后，43 项路由/入口聚焦测试通过。测试输出 `output/reader-cleanup-20261102/reader-cleanup-final-suite.txt`；新边界测试另覆盖 CLI、进程内 HTTP 冻结 OCR、其他页面实图拒识、包源码哈希、模板列表与草稿限制。

旧 suite 中要求其他页面继续可用的场景已移除或改为负样本；不把测试数量减少描述为识别能力提升。新增检查为 `tests/test_reader_page_boundary.py`。完整套件通过前曾出现旧模板依赖失败，日志保留在 `/tmp/reader-cleanup-suite*.txt`；修正了新测试选样和响应形状错误。

六个迁移模块的函数/类 AST 与基线逐项一致；完整输出对照和测试日志留在 `output/reader-cleanup-20261102/`。没有另一个 Agent 或人工独立验收。

GitNexus 修改前识别到公共入口 CRITICAL/HIGH 影响，涉及 CLI、HTTP、飞书和模板预览，已向用户披露。图谱对部分私有符号/移动路径解析有限，结合 AST 导入迁移、源码依赖检查与实际测试，不把空图谱结果当作无影响。提交前执行 detect_changes 和 git diff --check。

## 回滚

清理以单独提交交付。没有切分支、reset、rebase 或强推。

若需撤销清理，在工作区干净、确认清理提交 SHA 后执行 `git revert <清理提交SHA>`，由新提交恢复原文件和注册。不要对有后续工作的分支使用 reset --hard。
如只需查看旧实现，可用 `git show backup/reader-before-page-cleanup-20261102:<路径>`。数据目录没有修改。

## 下一 Session

本片完成并停止。后续若继续，应先核对 mold 标准参数合同，再决定新增页面；不得自动把其他品牌旧实现重新注册。

<!-- WORKFLOW_PROMPT_START -->
阅读 AGENTS.md、docs/150_PLAN_20261102_Reader单页面清理.md 和 docs/151_HANDOVER_20261102_Reader单页面清理完成.md，检查 git status 与最近提交。Reader 目前只支持 b_and_r.injection_holding.multi_stage_position_time，回滚基线为 backup/reader-before-page-cleanup-20261102。先汇报当前单页面目录和验证边界，等待用户指定下一任务，不自动恢复其他页面、不修改 mold、不部署。若用户要求接新页面，按控制器/页型/布局独立目录接入；先明确标准目标字段及真实图片验收预期。
<!-- WORKFLOW_PROMPT_END -->
