# 必需技能缺失引发的持续空跑

生产 M6_FANUC 确实未在有效推进。此前原 Session 续接成功，只证明调度恢复，不证明技能装配或业务完成。该执行的候选始终为 `8423caee60a48688a28381e30eb1e4f9737f6063`，最近多轮均报告缺少 how、architect 和 principle-model-the-domain，没有源码改动，也没有重跑测试。

## 三个直接原因

1. 已授权并实际挂载的仅是 poteto-mode 包。宿主存在的兄弟技能通过 symlink 暴露在安装目录中，但严格沙箱没有获得这些目标目录的授权，不能读取。原项目 runtime 声明只有 browser，没有 skills 完整性预检。
2. 实际回执返回 blocked，却缺少 blockerKind。解析器将任何非空的解析失败都降为 working，包括格式错误的显式阻塞结论。真实回执重放在旧版返回 working，修复后明确拒绝，进入既有结果补收。[重放结果](../evidence/skill-continuation-20261022/trace-replay.json)。没有从自然语言猜测阻塞类别。
3. 无进展指纹把工具请求预览当成已完成的调查成果。每轮生成不同的报告路径，便不断刷新指纹，绕过连续无进展上限。工具事件只有请求预览，不能证明命令执行成功或发现新事实。

## 本次代码修复

普通无结构化标记的进度仍按 working 继续；出现显式 TASK_GRAPH_IMPLEMENTATION 标记后，解析错误沿既有 result_incomplete 路径处理，保留原任务资格。指纹仅取已保存代码树、真实资料回执及用户输入，删除原始工具请求预览。补充必需能力缺失的正确结构化回执示例。

调查可能在没有上述可保存成果时触发既有三轮无进展上限；本次没有扩大预算或将任意日志写入视为成果。普通 Topic 新回复仍可接回原 Session。没有新增调度器、状态、wake source、项目特判或材料类别白名单。

## 隔离验证

- 扩展真实 Coordinator 回归，每轮为同一失败探针生成新的回执路径。修复前不能收敛；修复后普通进度与格式错误的阻塞两条分支均在四轮结束后停止空跑，未伪造交付，独立后继仍通过。
- 原 Session 绑定夹具验证普通多轮实施、原 Topic 回复、输入去重和后继派发；工具请求或模型声称进展不能刷新指纹。
- 新增 task-graph-skill-claim，使用真实 Project Capabilities、claim 入口、runtime pin 和 Bubblewrap。在旧 claim 中拒绝新增工具挂载；通过正常 continue_work 到 ready 后，显式批准资源，再由原 claimExecution 领取新 claim。三个技能文件在沙箱内实际读取。旧 pin 逐字不变，原任务、Worktree、候选及预算保留。此入口验证历史路线没有 snapshot capabilities 的场景，不宣称可直接升级仍持有旧 claim 的任意任务。
- natural-blockers、admission、runtime-pinning、project-capabilities-scope-change、skill-runtime 回归通过。原有材料范围授权仍不能用来扩大旧 claim 的工具挂载。

可复现命令：

```bash
npm run test:task-graph-postgres -- task-graph-result-recollection persistent-ticket-agent-t1 task-graph-skill-claim task-graph-natural-blockers task-graph-admission task-graph-runtime-pinning project-capabilities-scope-change task-graph-skill-runtime
```

## 技能装配及生产边界

已制作固定工程包，含 poteto-mode、该项目工程流程及其原则依赖，共 36 个所选技能目录、126 个普通文件。不是整个宿主 skills 目录。目录为 `/home/hello/.agent-platform/runtime-resources/pstack-engineering-635440398b945f04dd11372c`，SHA256 为 `635440398b945f04dd11372c795a67bd862bb3030e91fb50c89c5bf10b458000`。完整选择、文件和 runtime 声明见[包清单与真实沙箱预检](../evidence/skill-continuation-20261022/bundle-preview.json)。未授权时预检拒绝；隔离授权后 126 个文件读取及原 check-playbooks 脚本通过，项目 adaptation 匹配。

生产调度器通过 SIGTERM 平稳排空，不改任务账本。只读核实 M6 已自然进入 ready、claim 为空、revision 505。这个边界可供下一次正常领取固定新资源；并非手工重置。新增包仍等待 536 第 6 节要求的独立资源授权，不能由修复或继续请求隐式授予。生产项目配置尚未改，旧 runtime pin 未改，未恢复其他暂停节点。

本报告的隔离通过不等于生产技能装配完成，更不等于 M6 业务验收通过。正式启用后仍需记录原 Session 的实际技能读取、代码与测试成果和独立验收结果。


## 停止空转后的资源交接补齐

正式修复上线后，生产 M6 在同一候选上达到 unchangedTurns=3，自动停在 waiting_for_user。只读核实至 23:05 CST，部署后仅开启 4 轮，最后一轮始于 22:49:12；此后没有继续开轮，四类预算均为 0。[生产停止空跑证据](../evidence/skill-continuation-20261022/deployed-loop-observation.json)。固定工程包尚未获生产授权。

为避免必须抢占短暂 ready 间隙才能升级资源，既有 `project-capabilities:scope` 增加显式 `--prepare-runtime-upgrade` 模式。默认模式继续拒绝旧 pin 的挂载变化。新模式仅在已退出 Writer、implement 等待阶段、原 claim/候选/旧 pin 及完整新 policyHash 匹配时，追加原有 project_capability_scope_approved v2 回执，记录 runtimeUpgradeRevision；不直接恢复任务。批准在相同 claim/候选中可等待预检重试，提交放行仍核验当下 revision/CAS。

仅只读的 inspectSavedTaskRuntime 可据该回执预检下一 claim 的资源。实际执行入口仍不能替换旧 pin。原 admitNode 在预检成功后正常放行，claimNode/claimExecution 领取新 claim 并固定新 pin。明确批准的资源变化可越过原无进展指纹一次，全部旧预算及 unchangedTurns 保留。新 claim 不再匹配旧升级回执，不能重复绕过保护。没有新调度器、状态或 wake source。

新回归覆盖已停止空转的执行、活动 Writer 拒绝、错误 claim/候选/pin/未来 revision 拒绝、旧 claim 拒绝直接使用新包、原入口放行、新 claim 固定及历史 pin 不变。将包内已验证的 SKILL.md 入口传给 Agent，避免继续沿用旧宿主安装路径。隔离真实包验证也证明入口出现在最终阶段说明中。

当前生产只读预览确认 M6 Writer 已退出，固定候选可以使用该交接模式。预期新 policyHash 为 `47e9232450707f4c93adc1ad9826c3b0ea9926a1eea9572d8a62a8892e9a0ae9`。只增加前述单一固定包目录和 skills 声明，保留已有 browser、Python、资料源及主体。生产配置、scope 回执及业务账本尚未应用此预览。其他暂停节点不由本次操作恢复。

## 修改文件

- `src/lib/task-graph/implementation-result.ts`、`continuation-work.ts`、`prompts.ts` 修复阻塞解析、无进展计量及回执合同。
- `src/lib/task-graph/approved-runtime-upgrade.ts`、`runtime-continuity.ts`、`runtime-preflight.ts`、`preparation-recovery.ts` 处理已批准资源的下一 claim 预检、入口传递及原入口放行。
- `src/lib/project-capabilities/legacy-scope.ts`、`scope-resolution.ts` 和 `scripts/project-capabilities-scope.ts` 扩展既有显式 scope 批准。
- `tests/task-graph-result-recollection.test.ts`、`persistent-ticket-agent-t1.test.ts`、`task-graph-skill-claim.test.ts` 和 `scripts/test-task-graph-postgres.mjs` 保存真实控制流回归。
- 本文及 `docs/evidence/skill-continuation-20261022/{trace-replay,bundle-preview,deployed-loop-observation}.json` 保存诊断和隔离资源证据。

更正与后续：离线预览 hash `47e923...` 的目录集合存在转译错误，未应用生产。保留全部原目录后，实际新 hash 为 `bd718a202061ba7771244e8ecd6cbd3c0f16fa21736e0ab23eb309b68a75d674`。用户随后明确要求直接用 M6 验证，资源已按该范围启用；真实结果见 [539 业务验证记录](539_REPORT_20261022_M6FanucLiveSkillVerification.md)。
