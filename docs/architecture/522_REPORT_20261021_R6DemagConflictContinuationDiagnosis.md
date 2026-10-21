---
doc_type: REPORT
doc_status: diagnosed_read_only
---

# R6_DEMAG 冲突修复续接调查

## 结论

R6_DEMAG 已经越过技能环境故障并完成一轮业务实施。本次暂停发生在后续合流冲突修复。根因是平台首次执行与原生 Session 续接使用了不同的阶段输入，冲突修复协议没有进入实际续接消息。只读沙箱按计划生效，Agent 却收到直接修改源码的旧式要求，最终误报为环境权限故障。

本轮只读调查，没有改代码、权限、原运行记录或产物，也没有恢复任务。

## 实际经过

- 恢复后的实施 TaskRun `cmvgs23jd2vzdvo4ge2nb4dbn` 交付德马格总览页适配，实施记录指定检查 19 项、既有回归 55 项通过。这是实施证据，尚非独立验收通过。
- 保存候选 `9f5c679a42acd05c8ee79f09fc7c03d035bd34f5`。
- 与伯乐集成提交 `e11cef054d1d68c894538e7195eb3233c62f12f1` 合并，两边修改了 `scripts/raw_observations.py` 分发入口，并在 `docs/specs/hmi-protocol-library/raw-contract.md` 追加说明，产生两处真实文本冲突。
- 平台启动冲突修复 TaskRun `cmvgtfllg3u9ivo4gpo2y9z7x`，续接原 Session `01a1587f-89e7-78e3-a840-f066bd4bd444`。
- 本次工作目录切到独立运行目录，源 Worktree 只读。Agent 尝试直接改源文件，被只读挂载拒绝，随后报告 blocked/environment_failed。当前停在 `integrate / waiting_decision`，revision 19。

## 调用链根因

`coordinator.ts` 中 `executeJob` 对冲突阶段已设计受控产物协议：

1. `prepareAcceptanceRuntime` 提供可写运行目录和只读源码挂载。
2. Agent 在当前受管输出中写 `resolution.json`，每个冲突路径携带完整 `content`。
3. 平台在原 Writer 退出、claim/归属和输入哈希校验后，由 `finishConflictRepair` 应用结果、完成合并和复验。

但当前请求构造出现分叉：

- 传给 `implementationConversation` 的消息只有原任务描述、通用 recoveryInstructions 和用户输入。
- 传给 `executeAcpxTaskRun.taskDescription` 的另一份消息，才包含“源码只读、写 resolution.json、不直接改源码”的冲突阶段说明。
- `runner-harness.ts` 发现原 Session 时走 `adapter.resume`，使用 `participant.continuationMessage`。Codex Adapter 再将这段字符串直接作为 `resumeCodexSession.prompt`。

因此续接绕过了正确阶段请求，仍收到“使用保留的当前源码修复上述故障，并重新运行相同检查”。这是运行模式与实际任务输入不一致，不应通过放开源码写权限解决。

## 已核验证据

[脱敏证据](../evidence/r6-demag-conflict-diagnosis/findings.json) 包含实际启动记录和只读现场检查：

- 持久化启动消息长度 18535；没有 `resolution.json`，没有受控冲突修复说明，包含通用直接修源码要求。
- 修复报告的 mount 记录确认源 Worktree 是 `ro`，符合 `prepareAcceptanceRuntime` 的设计。
- Agent 保存的 `resolution.json` 只有路径、输入/输出 SHA 和 applied=false，没有每个文件的完整 `content`，不符合 `finishConflictRepair` 的解析契约。只补写权限也不会自动使这个产物合法。
- 当前两个冲突文件的 SHA 仍与保存的 conflictRepair.originals 相同；没有其他写入者偷偷解决或改坏现场。
- `git diff --name-only --diff-filter=U` 返回这两个文件；对当前 `raw_observations.py` 在内存做 AST 解析，稳定复现第 7 行 SyntaxError。未生成 pyc 或执行源码。
- 修复轮测试报告为 13 通过、6 失败；Agent 报告失败由冲突标记触发。调查独立确认标记导致语法错误，没有重新运行会写缓存/启动服务的业务测试。

证据原件保留在原受管修复目录 `.../aabc2fc27976ade91cdadc0e/`，以及忽略目录 `output/reviews/r6-demag-diagnosis-20261021/`。

## 修复方向，尚未实施

应让阶段执行请求只有一个来源，首次启动和 Session 续接消费同一份已构造的任务输入。复用已有冲突产物协议，不新增 Prompt 规则、状态机或权限例外。

回归必须覆盖“已有原生 Session + integrate/conflictRepair”：实际发给 resume 的请求包含与首次启动相同的阶段上下文；源文件保持只读，产物含两处完整文本，原 Writer/claim/哈希校验通过后才由平台应用，重复恢复不会重复写入。

本轮不应用 Agent 补丁，不转换旧产物，不直接修改冲突文件，不再次恢复这张 Ticket。

## 同批其他任务

当前 M05 已 passed；R6_BOLE 在独立验收阶段因缺少未参与调参的独立样本暂停，已通过项保留。它与 DEMAG 的冲突修复输入缺陷不同，不能一起重置或统一归为环境未准备。
