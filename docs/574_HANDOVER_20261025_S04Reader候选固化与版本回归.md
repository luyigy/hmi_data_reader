---
doc_type: HANDOVER
doc_status: in_progress
next_action: none
plan: docs/558_PLAN_20261025_双通路与M06纵向切片.md
slice: S04
plan_progress: in_progress
---

# S04 首个单元：Reader 候选固化与版本回归

## 授权、已完成与停止点

用户于 Feishu DM 08a216 2026-10-25 21:00:22 明确说“上轮我们已经完成了 S03，我们现在要进入 S04”。
按此新指令收尾 S03 并进入 S04，覆盖 573 的历史停止点；没有补造新版同卡的真人回读证据。
当前主对话 Task 为 full_access，不重复申请 M06 已批准的 Reader 目录。
本轮按照 558 每 Session 一个可验证单元的合同，完成 Reader 候选固化、版本回归及可重建源码副本。

Reader 候选 **5c6b6eb73d93e0bdf7c5cc4397a5f3c66efb38de** 已追加提交，父提交为原固定输入
**e9622681f765cbe0e1319696695f233f4c98c529**。分支 `manual/m06-reader-s04-20261025`。
候选工作区 `/data1/code/agent-platform-v2/output/manual-chat-s04-reader`，提交后干净。
这不是 Reader 集成或正式独立验收。Mold 候选仍为 **522ed9223f1b076b18b3ba157e562c77dea3db99**。

S04 整票仍 in_progress。生产输入绑定、Mold 正式入口、独立验收、部署和串行汇合均未完成。
本包保持 manual / next_action none；未启用旧自动化、修改 cursor/pending、发布 Issues、恢复 M06 或重载服务。

## 真实来源与候选内容

上轮平台提交 f54dcf7 / 763e5a6 / b27e4ba 已核对，S03 业务证据见 573。
本轮回读 M06 当前账本与最新原 Agent 报告，状态为 attention / implement / waiting_decision，
失败原因 agent_capability_missing。旧正式输入仍是 e9622681；历史报告为正式入口 24 通过、1 失败，
修复版开发实验 25 通过。该结果不是本轮重跑，也不是正式验收通过。

最新报告：
`/home/hello/.agent-platform/task-validation/150d5ec8261cadc3b40ee695/ea6c25908078b333e4b8ceca/implementation-report.md`。
同目录 delivery-state.json 列出原 Agent 六个 Reader 文件、版本和包哈希。

从资源工作区登记 `cmvnrskqc00023pj2tlkz9ca3` 核对 repository、baseline、checkout、device/inode 与 Git common dir。
原 M06 写作者经 observeExecutionWriter 核实 exited；复制前后核对 claim/revision，未靠 completed 状态代替退出证明。
原六文件按字节复制到新候选工作区，原资源 checkout 的 HEAD 与未提交内容保留。
Reader 共享仓 HEAD、status 和 tracked diff 哈希前后相同，未把共享目录其他人的修改带入候选。

本轮新增调整仅在候选的测试中：

- 原 R6 测试混用了默认新版包与写死的 1.0.0 路径。发布、导出、固定绑定、禁用/恢复和篡改测试现在随所测包版本传参。
- 增加旧 1.0.0 包仍能导出并通过合同校验的回归，且其识别器哈希与新包不同。
- 旧 1.0.0 包与基线逐字节一致，文件 SHA-256 为 `1a740520b6d6e5c50122a24ba124396abfff69c79677fa67f3288883b1238def`。
- 识读算法、新包和模板档案沿用原 Agent 文件，没有重新生成或改变新包哈希。

新包版本 1.0.1，合同使用的包哈希仍是
`91767f5020f01a9c11374842bef38408a7ebada9ff8209812b22f505240c6f4f`，与 Mold 522ed922 的精确接纳一致。
这是规范化 JSON 的包内容哈希，不是文件字节哈希。

## 验证与遇到的问题

证据根目录 `output/reviews/manual-chat-s04/`。

1. 六文件原候选执行新增回归和原 R6 全套，共 38 项，得到 29 passed / 4 failed / 5 errors。
   `reader-red.log/xml` 保留原结果。9 项失败来自版本路径混用，不是新增识读断言失败。
2. 修正测试中的版本绑定并增加旧包导出后，39 passed，0 skipped，4 warnings。
   `reader-verified.log/xml` 是提交前与暂存树字节一致的候选工作区验证。
3. 用平台现有 materializeUpstream 在仓库锁内从新提交生成源码副本，逐文件校验 Git blob 与执行权限。
   副本位置：`/home/hello/.agent-platform/task-upstream-sources/4ca3456d86e44cdc854f1b53/5c6b6eb73d93e0bdf7c5cc4397a5f3c66efb38de`。
   新副本实际重跑同一入口，39 passed / 0 failed / 0 skipped，记录在 `reader-frozen.log/xml`，与生产 task_inputs_prepared 绑定分开。
4. 两张真实原图重新经过 CPU OCR，development 为 15/1/3 秒，retained 为 10/3/0 秒，均 known/s。
   `fresh-ocr-times.json`、`live-development.json`、`live-retained.json` 可读回。
5. GitNexus impact 对 observe_yizumi_page、published 返回 Target not found / UNKNOWN；
   staged detect_changes 识别 7 个文件但未识别符号，不据此声称零影响。
   实际调用者 raw_observations 与原 R6 发布/API/CLI 路径由源码及测试核对。
6. 首次测试没有预置归档模型，进入自动下载；停止本轮测试进程后核对并复制既有归档的 9 个模型文件。
   一次复制命令使用了错误相对输出路径，已改为绝对路径；不计入成功测试。
   `model-verification.json` 保存来自既有 archive manifest 的逐文件 hash，正式成功测试使用这些模型。
7. materializeUpstream 首次受默认 256 MiB 限制拒绝。核对运行中 coordinator 的现有配置为 512 MiB，
   使用相同配置成功，未修改生产限制。基线树 308129662 字节，新候选树 308335931 字节。
8. 曾尝试让旧 1.0.0 包使用新版当前识别器执行，得到预期源码哈希不匹配。
   `old-runtime-hash-mismatch.log` 保留结果。没有放松生产哈希校验。
   临时新增回放测试误将裁剪的 OCR 观测夹具当成完整 page_observations.v2，也明确失败并改为实际旧包导出验证。
   本轮不声称已经验证旧绑定重新识别或 Mold 的历史保存记录回放。

可重跑命令，在上述新提交源码副本或候选工作区执行：

```bash
PYTHONDONTWRITEBYTECODE=1 \
AP_GRAPH_OUTPUT_DIR=/data1/code/agent-platform-v2/output/reviews/manual-chat-s04 \
OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
/data1/code/hmi_data_reader/.venv/bin/python -m pytest -q \
  tests/test_yizumi_raw_row_alignment.py tests/test_hmi_protocol_library_r6_yizumi.py \
  -p no:cacheprovider \
  --basetemp /data1/code/agent-platform-v2/output/reviews/manual-chat-s04/pytest-frozen \
  --junitxml /data1/code/agent-platform-v2/output/reviews/manual-chat-s04/reader-frozen.xml
```

4 个 warnings 来自依赖弃用及既有无效转义提示，未当作通过项或忽略失败。
本轮没有运行 Mold 正式入口，没有新的浏览器/保存 GET 验收结论。
平台 PLAN/HANDOVER 文档校验、长文件检查、两仓 diff check 通过。

## 下一 Session：继续 S04

先读取 558、本文、S04 票与 `output/reviews/manual-chat-s04/candidate.json`。
该 receipt 只记录手动候选来源，quality=unverified、productionInputBinding=not_applied、integrated=false；
不能把本文件或 Reader 分支 HEAD 当成任务图已经正式消费的新输入。

下一可验证单元是给 M06 追加明确的 Reader 候选绑定，使新一次实施与独立验收消费 5c6b6eb / 1.0.1 精确包。
旧 claim 的 task_inputs_prepared、R6 已通过记录、原批准快照和旧 sourcePath 均保留。
不能把旧输入的 passed 质量或旧报告自动继承给新候选。

重点入口：

- `src/lib/task-graph/upstream-inputs.ts` 当前只从前置已集成交付生成清单，旧清单按 claim 重放。
- `src/lib/task-resources/graph-workspace.ts` 当前将授权映射到固定基线 checkout，并仍提示“本轮不提交或汇合额外仓”。
  不能全局删掉此约束冒充已有跨仓范围；后续应按已批准交付绑定提示和能力。
- Mold 正式 `backend/tests/test_hmi_protocol_library_m6_yizumi.py` 仍须在准确固定输入下接纳新版本，
  不能继续用输出目录的实验副本代替正式入口。

之后由原任务角色完成修复/正式入口，独立角色验证新冻结候选，验证保存、独立 GET、双视口和旧记录回放，
通过才做串行汇合、发布读回和账本完成。原 Agent/Native Session 与 task/workspace 绑定保持。
本 Session 按 558 的一个可验证单元约定提交和交接后停止，下一轮仍是 S04，不进入 S05。

## 修改文件

Reader 候选 5c6b6eb 含 7 个文件，前六个原 Agent 文件在新候选固化，其中新增回归文件再补旧包导出检查：

- `scripts/raw_yizumi.py`
- `templates/packages/yizumi.injection_metering.injection_holding_f2/1.0.1.json`
- `templates/versions/yizumi.injection_metering.injection_holding_f2/1.0.1.json`
- `tests/fixtures/yizumi_row_development_live.json`
- `tests/fixtures/yizumi_row_retained_live.json`
- `tests/test_yizumi_raw_row_alignment.py`
- `tests/test_hmi_protocol_library_r6_yizumi.py`

平台只改文档，没有产品运行时代码改动：558 PLAN、S03 票、S04 票、本文。
准备与核对脚本、候选 receipt 和日志保留在上述 output 证据目录，不作为新的自动化入口。
