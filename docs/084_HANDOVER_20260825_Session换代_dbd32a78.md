---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: null
plan_progress: complete
---

# HANDOVER · Session 换代检查点

- Room：HMI-Reader
- Task：Live Room · HMI-Reader
- Agent：codex, claude, kimi-code, ds
- Git HEAD：05db87e033565e67e9acfaaa3b398b4c603ebfd4
- 未完成 PLAN：docs/082_PLAN_20260825_通用HMI结构化候选协议.md

## 工作区状态

```text
M AGENTS.md
 M CLAUDE.md
 M hmi_service.py
 M scripts/extract_fields.py
 M scripts/vlm_qwen.py
 M templates/tact.temperature.json
 M tests/test_generic_extraction.py
 M tests/test_vlm_text_mapping.py
```

## 最近上下文

[2026/8/25 22:09:12] codex: 我会按当前工作流限制，把 082 的触发状态改成精确的 `ready / start_first_slice`（你说的 “Ready Start First Light” 对应这里的首个 Slice 启动标记），只改计划状态，不实施 S01。先读取项目文档命名规范和极简修改约束，再核对计划里的实际字段。

现有文档确实仍是 `draft / await_plan_approval`，正文也明确说批准后才切换，所以不会触发。`handover-file-naming` 要求保留现有 PLAN 文件名；Ponytail 约束则把变更压到这一个状态字段组合，不新增流程说明。现在我核对仓库中已能触发的 PLAN 样例，避免拼错机器识别值。

合同确认了触发条件是三件套：`doc_status: ready`、`next_action: start_first_slice`、成对的 `WORKFLOW_PROMPT`。我会三项一起补齐，并同步删掉正文里“当前不会触发”的矛盾描述；提示词只派发 S01，不会越过到 S02。

状态与 Prompt 已改完，且没有触碰代码。接下来按仓库规则做三项收口：验证文档合同、确认 GitNexus 只看到预期的文档变化、检查暂存范围后单独提交这次 PLAN 修订。

检查发现一处纯文案不一致：表头还写“获批后动作”，但状态已经 ready。我会顺手改成“派发后动作”，避免执行者误判；随后调用 GitNexus 的变更检测。

GitNexus 对整个工作树给出 `HIGH`：17 个既有代码符号、8 条流程受影响，来源是早先未提交的 `hmi_service.py`、`extract_fields.py`、`vlm_qwen.py` 等，并非这次 PLAN。此次文档本身没有代码符号；我会只暂存 082，再用 staged 范围复核，确保提交不夹带这些改动。

staged 复核通过：只有 082 PLAN，GitNexus 为 `0` 个符号、`0` 条流程、风险 `none`。我再做一次机器触发字段与 Prompt 标记计数检查，然后按规范单独提交；提交钩子会执行仓库的 workflow preflight。

已按工作流限制修正并提交，Commit：`c1d762c`。

- 状态改为 `ready / start_first_slice`。
- 加入只派发 S01 的 `WORKFLOW_PROMPT`，禁止进入 S02。
- GitNexus staged 检查：0 个符号、0 条流程，风险 `none`。
- 未修改或提交工作区原有代码；未遇到问题。

修改文件：[082 PLAN](/data1/code/hmi_data_reader/docs/082_PLAN_20260825_通用HMI结构化候选协议.md)

<!-- HISTORICAL_PROMPT_START -->
你是实施执行者。只完成 `docs/082_PLAN_20260825_通用HMI结构化候选协议.md` 的 S01，不进入 S02，不部署、不重启服务。

1. 读取本 PLAN、`AGENTS.md`、`docs/workflow/workflow-contract.yaml`，检查并保护工作区已有修改。
2. 修改 `draft_from_ocr` 及其使用的每个符号前执行 GitNexus upstream impact；HIGH/CRITICAL 先警告并停止修改。
3. 只修改 `scripts/vlm_qwen.py` 和 `tests/test_vlm_text_mapping.py`，实现 S01 合同。
4. 运行聚焦测试和可行的全量回归。
5. 完成变更检测和检查，创建 S01 HANDOVER，只提交 S01 代码、测试和 HANDOVER，然后停止。
<!-- HISTORICAL_PROMPT_END -->
[2026/8/25 22:10:26] 你: 那其实还有一个问题啊，我们现在这里只管了温度、射胶、保压、冷却时间这些。

那如果以后我还要加一个字段呢？比如说周期时间，或者说任何我现在没有想到的东西，以后这个可扩展性怎么保证呢？
[2026/8/25 22:13:09] codex: 我先核对 082 的协议设计和当前字段映射链路，判断它是真正“新增字段只加配置”，还是仍把温度/射胶/保压/冷却写死了。这里用 `gitnexus-exploring` 追执行流；如果计划确实漏了扩展合同，我会只修正 082 PLAN，不提前改实现。Ponytail 约束这次优先复用现有结构，避免为“未来所有字段”造一套过度抽象。

GitNexus 索引比 HEAD 落后 3 个提交；从时间线看主要是 082 文档状态提交，但按项目规则我仍先刷新索引，再据最新代码/计划判断扩展性，避免把旧结构当成现状。

初步结论：082 的方向已经允许“目录外字段”，但“保证可扩展”还差一个可验收的硬条件——新增“周期时间”这类字段时，不能要求改 `draft_from_ocr` 的分支、枚举或 JSON 结构；最多只应补 canonical 目录映射，甚至不补目录也能以 `canonical_id: null` 返回。接下来我核对 S01 验收项有没有把这件事真正锁死。

现有 PLAN 的开放结构是对的，不需要为每个新参数加 schema 类型或新接口；缺口只在“没有用一个未来字段做回归证明”。我会把“周期时间”加入 S01/S02 的强制验收，并写明扩展规则：未知字段零代码改动即可返回；只有要获得稳定 `canonical_id` 时才补目录。`handover-file-naming` 只要求原地更新现有 082，不新建文档。

计划已把扩展性从“口头原则”变成两层可执行门槛：S01 必须证明空 hints 也能返回未登记的周期时间，S02 必须证明 HTTP 不会过滤它。现在只暂存 082 文档，做 GitNexus staged 影响检查和工作流合同检查；不会夹带现有 8 个代码/配置改动。

检查通过：暂存区只有 082 PLAN；GitNexus 为 0 个代码符号、0 条执行流、风险 `none`；`ready / start_first_slice` 与唯一 Prompt 标记仍完整。现在提交这次扩展性验收修订。

你提得对：当前实现仍受 `allowed_fields` 白名单限制，扩展性尚未真正实现。

我已修订并提交 082 PLAN，Commit：`05db87e`：

- 未登记字段（例如“周期时间”）也必须返回，`canonical_id: null`。
- 新增字段不得修改 API 结构或添加字段专用代码分支。
- 只有需要稳定业务映射时，才补字段目录。
- S01/S02 都增加“周期时间 + 空 hints”回归验收。
- GitNexus：0 个代码符号、0 条流程受影响，风险 `none`。
- 未触碰工作区现有代码修改；无阻塞。

修改文件：[082 PLAN](/data1/code/hmi_data_reader/docs/082_PLAN_20260825_通用HMI结构化候选协议.md)

<!-- HISTORICAL_PROMPT_START -->
你是实施执行者。只完成 `docs/082_PLAN_20260825_通用HMI结构化候选协议.md` 的 S01，不进入 S02，不部署、不重启服务。

1. 读取本 PLAN、`AGENTS.md`、`docs/workflow/workflow-contract.yaml`，检查并保护工作区已有修改。
2. 修改 `draft_from_ocr` 及其使用的每个符号前执行 GitNexus upstream impact，报告 direct callers、受影响流程和风险；HIGH/CRITICAL 先警告并停止修改。
3. 只修改 `scripts/vlm_qwen.py` 和 `tests/test_vlm_text_mapping.py`，按 S01 合同实现通用 `sections/fields/items`、通用 `role`、canonical hint 匹配、融合和严格校验；用未登记的“周期时间”证明新增字段无需生产代码分支。
4. 运行 S01 聚焦测试和可行的全量回归；不得为了通过而删除或放宽既有测试。
5. 结束前运行 GitNexus `detect_changes({scope: "compare", base_ref: "master"})`、workflow preflight 和 `git diff --check`；创建合同有效的 S01 HANDOVER，只提交 S01 代码、测试和 HANDOVER，然后停止。
<!-- HISTORICAL_PROMPT_END -->

## 下一步

- 在新 Session 中先核对本文件、Git HEAD 和工作区状态，再等待用户下一条指令。
