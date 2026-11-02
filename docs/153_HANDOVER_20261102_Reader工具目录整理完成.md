---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: docs/152_PLAN_20261102_Reader工具目录整理.md
slice: S01
plan_progress: complete
---

# Reader 工具目录整理完成

## 结果与边界

用户授权按用途整理 scripts，并为每个文件夹提供 Markdown 说明。基线分支 deploy/yizumi-auto-page，提交 3c90b4250d0d1656c673a9a7716fd37019ea753b，开工工作区干净。本地标签 backup/reader-before-tools-cleanup-20261102 固定基线。

顶层 Python 文件从 130 个减少到 20 个。移动 28 个工具，删除 82 个过期一次性脚本；旧阶段编号不再用于新工具名。当前 11 个源码目录均有 README，逐文件说明用途、调用方式和执行影响。Python 包标记文件没有业务逻辑。

B&R 页面算法、HTTP 服务、字段目录、schema、模板及冻结包保持不变。专属回放脚本移动到该页面目录；冻结包的源码清单不含此工具，因此未新增包版本。mold、原图、标注、真值、训练/模型产物未修改。没有实际下载、训练、GPU 推理、飞书发送、模板发布、服务安装/重启或推送。

## 目录与迁移清单

入口 scripts/README.md。工具按 data_tools、training、evaluation、diagnostics、integrations、operations 分类，原 scripts/README.training.md 合并到 training/README.md 并保留历史训练说明。B&R 的 verify_stability.py 跟随页面目录。

| 原路径 | 新路径 |
| --- | --- |
| `scripts/aggregate_record.py` | `scripts/data_tools/aggregate_record.py` |
| `scripts/datasets.py` | `scripts/data_tools/datasets.py` |
| `scripts/feishu_download_v3.py` | `scripts/data_tools/feishu_source.py` |
| `scripts/download_training_images.py` | `scripts/data_tools/download_training_images.py` |
| `scripts/prepare_training_packet.py` | `scripts/data_tools/prepare_training_packet.py` |
| `scripts/prepare_training_review.py` | `scripts/data_tools/prepare_training_review.py` |
| `scripts/package_reviewed_evaluation.py` | `scripts/data_tools/package_reviewed_evaluation.py` |
| `scripts/build_evaluation_sets.py` | `scripts/data_tools/build_evaluation_sets.py` |
| `scripts/audit_evaluation_candidates.py` | `scripts/data_tools/audit_evaluation_candidates.py` |
| `scripts/s054_batch_download.py` | `scripts/data_tools/download_images_batch.py` |
| `scripts/download_training_model.py` | `scripts/training/download_training_model.py` |
| `scripts/train_small_sample.py` | `scripts/training/train_small_sample.py` |
| `scripts/serve_finetuned.py` | `scripts/training/serve_finetuned.py` |
| `scripts/serve_unsloth.py` | `scripts/training/serve_unsloth.py` |
| `scripts/verify_accuracy.py` | `scripts/evaluation/verify_accuracy.py` |
| `scripts/score_relations.py` | `scripts/evaluation/score_relations.py` |
| `scripts/vlm_eval.py` | `scripts/evaluation/vlm_eval.py` |
| `scripts/vlm_text_eval.py` | `scripts/evaluation/vlm_text_eval.py` |
| `scripts/s054_recognize_batch.py` | `scripts/evaluation/recognize_batch.py` |
| `scripts/annotate.py` | `scripts/diagnostics/annotate.py` |
| `scripts/classify_with_postprocess.py` | `scripts/diagnostics/classify_with_postprocess.py` |
| `scripts/explain_case.py` | `scripts/diagnostics/explain_case.py` |
| `scripts/check_candidate_http.py` | `scripts/diagnostics/check_candidate_http.py` |
| `scripts/feishu_card_assistant.py` | `scripts/integrations/feishu_card_assistant.py` |
| `scripts/manage_page_templates.py` | `scripts/operations/manage_page_templates.py` |
| `scripts/profile_lifecycle.py` | `scripts/operations/profile_lifecycle.py` |
| `scripts/run_pipeline.py` | `scripts/operations/run_pipeline.py` |
| `scripts/verify_b_and_r_stability.py` | `scripts/extract_families/b_and_r/injection_holding/multi_stage_position_time/verify_stability.py` |

活动测试导入、命令路径和仓库 systemd 示例已同步；旧路径不保留空壳包装。已核对本机 ~/.config/systemd/user/hmi-finetuned.service 与 hmi-unsloth.service 仍引用旧模块路径；没有修改它们。后续实际部署或重启前，必须先同步配置。实际部署时应对照 docs/hmi-finetuned.service 和 docs/hmi-unsloth.service 更新启动模块后再重启，不能把示例文件更新当作已部署。

删除项包括其余 77 个阶段编号脚本、旧 feishu_download.py、make_comparison_doc.py、make_summary_doc.py、nightly_runner.py、check_023_rejection_scoring.py。完整移动/删除清单保存在 output/tools-cleanup-20261102/tools-layout.json，Git 提交记录也可复查。不移动历史数据；历史编号文档中的旧命令保留作为历史，不作为当前运行说明。

批量识别工具额外支持 --input-dir、--output-dir、--url；原 --batch-id 继续指向旧批次目录。没有改变字段提取或自动接纳语义。

## 验证与限制

- GitNexus MCP 连接断开后，先成功刷新本地索引，再用本地 LocalBackend impact 上游分析 384 个符号：382 LOW、2 HIGH。HIGH 为 verify_accuracy 的 flatten_scorable 和 compare_elements，各 2 个直接调用，涉及单图诊断、真值评测和文本评测，已向用户披露。移动导入使用 AST 分析，函数业务逻辑保留；仓库根目录表达式随目录深度调整。
- 完整套件：`PYTHONPATH=scripts:. PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest tests -q --tb=short`。289 passed、12 skipped、22 subtests passed；3 条原 FastAPI/Starlette 弃用警告。跳过的是在线/跨仓环境检查，没有独立人员或另一 Agent 验收。
- 14 项新目录与实际 CLI 检查通过，包含从仓库外运行工具帮助、目录 README 覆盖、无阶段编号脚本、隔离 mock 验证批量识别目标地址；不启动真实外部操作。
- 7 张历史 B&R 照片的冻结 OCR 回放：131 个读数及启用状态与原真值一致。results.json、matrix.json、model-inputs.json 与上一片完整相等；不是新在线 OCR 准确率证明。
- CPU 辅助检查通过：check_training_download、check_training_packet、check_training_sample_isolation、check_round2_training、check_finetuned_service、check_evaluation_sets。模型下载用 mock SDK 和临时目录，不联网下载真实权重。
- check_unsloth_service 在 Reader .venv 中因缺 transformers 失败，改用其声明的 /data/venvs/hmi-unsloth/bin/python 后通过，未加载 GPU 模型。
- check_tact5_intake 在 source_answer_sha256 断言失败；用基线 3c90b42 原训练模块及原测试复现同一第 30 行失败，属于已有数据来源哈希问题。没有改动数据或放宽断言，不列为通过。
- 已确认聚合工具的 POSTPROCESS_PATH、数据集和评测 ROOT、流水线 HERE 指向原仓库/公共 scripts 目录。编译、git diff --check、源码长度与退役导入检查通过。提交前本地 CLI detect_changes 已完成，报告 low、61 files/25 symbols。它未完整表示模块移动和删除，实际提交按 Git 文件差异、AST 导入检查及测试核对；不将“affected processes: 0”解释为没有调用影响。

验证日志、impact 和清单位于 output/tools-cleanup-20261102/，生成产物不提交。历史标注和训练结论不因工具移动而重新获得准确率或真值认证。

## 回滚与停止

本片单独提交，可用 `git revert <本片提交SHA>` 撤销；不需要 reset。旧工具内容可用 `git show backup/reader-before-tools-cleanup-20261102:<原路径>` 查看。原页面清理标签 backup/reader-before-page-cleanup-20261102 仍保留。

本片完成即停止，不自动扩展其他页面、修复历史 TACT5 数据或部署服务。

<!-- WORKFLOW_PROMPT_START -->
阅读 AGENTS.md、scripts/README.md、docs/152_PLAN_20261102_Reader工具目录整理.md 和 docs/153_HANDOVER_20261102_Reader工具目录整理完成.md，检查 git status 与最近提交。工具已按用途归类，当前只支持 B&R 射胶保压页；旧路径和阶段脚本已退役。先汇报状态并等待用户指定下一任务，不自动恢复页面、启动 GPU、修订数据、发布模板或部署。需撤销本轮整理时，以 backup/reader-before-tools-cleanup-20261102 和本片提交为依据使用 revert。
<!-- WORKFLOW_PROMPT_END -->
