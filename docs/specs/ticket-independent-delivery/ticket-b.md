<!-- ap-publish:ticket-independent-delivery-20261023:S02_B -->
<!-- ap-ticket-v1 {"version":1,"project":"ticket-independent-delivery-20261023","sliceKey":"S02_B","parent":"gitee:luyi1678/agent-platform-v2#IKQ2GA","blockedBy":["gitee:luyi1678/agent-platform-v2#IKQ2GB"]} -->

# [S02_B] 真实 Agent 与旧任务兼容验收

Parent: https://gitee.com/luyi1678/agent-platform-v2/issues/IKQ2GA
Blocked by: https://gitee.com/luyi1678/agent-platform-v2/issues/IKQ2GB

## 独立目标与前置

S02_A 正式 passed 后，对其固定集成版本取得真实 Coding Agent 独立交付和旧 Reader/Mold 原合同兼容证据。只做验收准备、真实运行、必要的测试驱动及报告；发现产品缺陷交回现有获批修复流程，不在本票偷偷扩大产品代码修改。

## 执行范围

一个 Node/Execution，主仓 /data1/code/agent-platform-v2；consumeUpstream=direct 消费 A 固定交付。Reader /data1/code/hmi_data_reader 和 Mold /data1/code/mold-data-webpage-tool 仅声明 read extra repo，用于读取既有固定素材与代码。真实测试节点的主仓 worktree、服务和读写范围由后续测试路线明确提审；此票不获得旧共享业务数据写权限。

可在 docs/specs/ticket-independent-delivery/ 交付验收报告与现有账本证据索引；可在 tests/ 新增本票专用只读证据断言脚本 tests/task-graph-ticket-independent-live-evidence.test.ts 和必要测试驱动。该脚本只核对本次真实验收事实，不接入平台运行期、不成为新质量门禁、不创建追溯数据库实体。不能仅检查文件存在、字数、人工 true 标志或 mock 结果来判定通过。

## 验证步骤与完成标准

1. 读取 A 的正式集成 SHA、独立验收结果和源代码；报告执行版本与 A 的关系。没有 A passed 不开始。旧票最新状态、活动 TaskRun、批准 hash 先只读核对。
2. 按 Spec 的 IA/IB/IC/ID 设计准备最小新合同测试路线并走既有 Issue/路线卡批准。把真实样本/哈希/真值、两仓固定 SHA、隔离端口与命令、各节点质量模式写入卡片。未批准不派发；不得将本票批准解释成子测试路线已经批准。
3. 使用真实原生 Agent：IA 完成和 ID 释放时 IB 仍未完成，IC 保持 planned；IB 正式通过后 IC 才释放一次。IB 的未完成窗口用批准的 waiting_for_user 步骤与真实用户回复，不手改账本/暂停生产进程。保留 Node/Execution/TaskRun/session、事件时间及 commit 证据，资源排队与逻辑依赖分开报告。
4. 实际证明单票原 Session 自查及必要补验；获批 Tester 和人审真的执行。人审等待与真实批准记录齐全，修复后的新 Commit 不复用旧通过结论。外层本票的 Tester 不能代替内层被测的 Tester/人审。
5. 旧 Reader/Mold 不改 snapshotHash、验收模式、批准检查或历史通过证据；已通过 R6/M6 不重跑。对尚未完成 M6_ARBURG、M6_YIZUMI 先核对环境/材料，条件确实改变后按原合同和现有授权流程合法续接；无条件改变不重试。M07 仅依赖满足后由旧路线自然推进。本票不自行宣布旧路线全部完成。
6. 旧合同静态不变与真实续接两项分别验收：若浏览器/独立材料仍缺，报告 B 此项未完成，保留新合同已验证部分。旧业务通过也不能替代新 agent_owned_v1 真实证据。
7. 报告与只读断言入口实际回读本次正式记录，拒绝遗漏、错 SHA、模拟 Agent 冒充真实 Agent、旧回执复用、未批准运行。执行 node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/task-graph-ticket-independent-live-evidence.test.ts，另运行 npm run check:long-files、git diff --check。验收脚本在本票实现，当前不存在且不得先报通过；它只帮助独立 Tester 重放核对，不替代 Tester 的工程判断。
8. 未参与编写的独立 Tester 对固定 A SHA、真实日志/图像/GET 读回、人审记录、旧合同前后记录逐项复核，缺必需证据不得通过。不得用 A 的 mock/隔离测试或本票报告自述代替实际观察。

## 限制与完成口径

不承诺一个 Session 完成。没有生产部署/重启/中断 TaskRun/迁移旧票的授权；若需要上线候选版本，按既有流程单独确认。不得自动重跑 passed 票、删批准检查或引入状态机/角色/恢复管理器/质量门禁/追溯实体。新增风险先记录。全部必需项和独立审查通过才算 B 完成，缺项明确 blocked/待完成，不把“已准备测试”写成 delivered 通过。
