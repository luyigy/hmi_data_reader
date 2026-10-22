# Ticket 自然执行：最小垂直切片 B

基线为 `1f5dcf597f90f5c5d932fad8e879f0b9d42074a1`，A 为 `e1d4812`。实现位于独立开发分支 `fix/natural-ticket-continuation-20261022`。527、528、529 作为设计参考，本报告结论来自实际源码与隔离回归。没有部署，没有修改或恢复 Reader/Mold 生产账本。

## 改的是哪一层

改 Task Graph 的继续领取、结果处理和事务边界。复用现有 Coordinator、ExecutionProgress、事件幂等键与 claim CAS。Coding Agent 继续承担调查、编码、测试和提问；Verifier 继续决定固定候选是否合格。没有新增 Scheduler、持久状态机、数据库表或 Prompt 框架。

```text
用户批准 Ticket / 原飞书 Topic
  Task Graph / Coordinator                  本次修改
    可靠消费继续请求
    普通工作、新回复、条件就绪 → 原领取路径
  原 Coding Agent Session + 独立 Worktree  保留
  Sandbox Manager / Capabilities / W001     保留
  Git 集成 / 固定候选 / 独立 Verifier       保留
  合格后继释放                             保留
```

## 实际行为变化

1. Agent 报告工具错误、资料不足或实现未完，不再仅按 blocked 类别转成审批。原 Agent 正常继续调查；确实提出权限或范围问题时，保存为 Agent 的问题。新回复进入原工作会话，回复本身不授予任何新资源权限。
2. 对旧 waiting_decision/exhausted，合法的新 Topic 输入可以走正常领取。保留原候选、Worktree、计数和 Session。Writer 必须实际退出，未知归属不放行。失败、取消或中断的 TaskRun 也必须有真实退出证明，不能仅凭状态继续。
3. 一次失败没保存 Session ID 时，只从同一 Ticket、同一 TaskSession、相同后端/harness/角色的历史参与者取回已记录的 Native Session。没有可靠记录则显式记录降级，不猜 Session。
4. 平台条件预检使用 Coordinator 空闲槽位，正常 ready 工作和人类消息优先。预检在事务外，短事务核对原 Writer/候选/批准身份后，回到现有领取入口。原实施失败继续实施，原验收失败只重试固定候选验收。
5. 不用 lifetime repair/platform 次数撤销工作资格。原计数完整保留。相同代码、输入和失败没有进展时停止空转；同一个就绪条件凭据不能反复启动模型。部署版本和实际容量配置可以区分有效的新条件，不作为权限来源。
6. 继续请求只有持久调度回执存在才消费；失败重试不丢请求。扫描时排除已完成请求，20 条已完成历史请求不会遮住真正待办。旧请求的幂等重放直接返回原回执，不重新派发或重新领取。
7. 工具返回 `HTTP / code / msg / detail`，`1254018 InvalidFilter` 不再被解释成授权失败。内容经过原有敏感信息过滤。
8. 技能可声明固定依赖包、摘要和必需文件，每个依赖目录必须有明确的宿主只读授权，真实 Bubblewrap 内逐个读取。没有跟随链接去扩大挂载，也没有开放整个宿主技能目录。

## 红绿证据

详见 `docs/evidence/natural-ticket-continuation-20261022/B/manifest.json` 及其日志 SHA256。

- 红：原实现把普通工程结果变成 waiting_decision；错误报告掩盖 InvalidFilter；必需技能依赖无法声明。实施过程中补充的真实失败轮次还复现了 Native Session 丢失，Resume 收到 null，错误保存在 red-native-session.log。
- 绿：5 轮原生会话身份连续，含一次真实失败返回、工程调查、旧格式权限问题和原 Topic 自然回复。最终候选经独立验收，才放行后继。批准快照没有改变，没有发送恢复控制命令。
- 绿：平台资源不可用时不调用模型，独立 Peer 仍交付；条件恢复后原候选与原 Worktree 正常领取，历史 platformAttempts=77 保持 77。验收环境修好后只启动一次固定候选验收，不重复实施。
- 绿：3 次不同的范围内缺陷反馈原 Native Session 修复，4 个固定候选各自验收，后继只放行一次。相同输入和缺陷仍会停止空转。
- 绿：18 项安全/兼容套件整批通过，包含真实事务超时、并发领取、候选漂移、Scope v2、真实 Sandbox Manager、存活 nonce 后代、W001、并行 Worktree、Git CAS、冲突修复、用户暂停和原房间卡片输入。
- `npm run build` 通过。其 prebuild 实际执行 W001 和 W01；W01 使用真实已安装 Codex 与确定性本地 provider，验证同 Thread Resume、Manager 生命周期与隔离。这不是生产业务实现或真实模型业务推理的证明。
- TypeScript、长文件守卫和 diff 检查通过。

历史显式 prepared-review 测试单独隔离了新自动消费者，以验证旧回执 API 的兼容性。真实自动路径由 condition-recheck 覆盖，未把这个旧回执测试冒充自动推进证明。

## 拆掉了什么，保留了什么

| 原有阻塞 | 本次处理 |
| --- | --- |
| 请求先写 started、调度失败后永远跳过 | 调度回执确认消费，失败请求保留 |
| 普通 blocked 分类直接进入人工决定 | 普通工程工作继续；问题由原 Agent 提出 |
| 旧 waiting_decision/exhausted 必须专用恢复命令 | 合法新输入走正常领取，不清计数 |
| 平台配置修好后旧节点仍等新审批 | 重新实际预检，条件就绪后正常领取 |
| 验收平台重试计数耗尽即永久等人 | 条件验证后可重试固定候选，原计数不变 |
| 运行资源错误或 DB 暂时错误被当成归属错误 | 复用平台故障分类，真归属错误仍拒绝 |
| 一个失败轮次没有 Session ID 就丢原 Session | 从同一 TaskSession 的可靠历史身份续接 |

保留旧 progress 枚举、旧账本和事件；`retry-limits.ts` 仍用于兼容和单轮安全限制。`preparation-recovery` 的旧显式回执、`conversation-recovery` 的旧控制请求、受控冲突恢复和重启恢复继续兼容。不删除旧证据，不批量改 attention，不重写批准快照。

## 未覆盖和仍会停下的路径

- Writer unknown/仍存活、候选或 claim/revision 漂移、授权撤销、用户明确暂停、不合格上游，均继续拒绝。它们不是通过新增输入就能绕过的资格检查。
- 受控冲突 Stage 的 blocked 结果仍有专用兼容分支，普通 Topic 输入未全部收敛到该只读源码/解决产物协议。出现这种情况时仍需现有受控恢复入口；本次不宣称所有 Stage 的每个历史分支已经迁完。
- Verifier 的协议无效、业务裁决和真正不可替代的信息不足仍保留旧处理入口。有效的范围内缺陷已经自动回原 Agent，但本次没有把所有验收对话都改成普通实施对话。
- 原始 Native Session 身份确实不存在时只能有证据地降级，不能伪造续接成功。
- 全仓历史测试不是本次的全绿声明。旧 review-repair 归档 fixture 与 conversation fixture 在未修改基线也失败，A 保存对照；旧 completed followup 的次数断言存在时序问题。本次运行并通过的是 manifest 中明确列出的套件。

## Reader/Mold 生产验收还缺什么

以下是下一步验收前置项，不是本次已完成的生产交付。

1. 用户另行确认合并/部署及原路线的生产恢复。随后核对部署产物 SHA，使用现有入口接回合法保存点。不能用 SQL 批量改状态或清空预算。
2. M6_BOLE 验证当前容量条件确实通过，再看原候选继续。M6_ARBURG 验证事务修复和真实必需工具装配。现有四个包外技能的具体声明见 B/mold-skill-dependencies.proposal.json，仅为提案，尚未授予新目录权限。
3. 工具/挂载变化必须由 Project Capabilities 的真实授权及受控新 claim 固定；旧 Runtime Pin 仍不可改写。当前 Scope v2 的材料变更不能被冒用成工具或挂载扩权。本次没有自动解决生产旧 Pin 与新增工具授权的迁移。
4. R6_FANUC 使用已有获批原图重新查询和识别，核对真实 API/CLI 输出。529 的旧审计材料不是本次重新执行的生产结果。
5. R6_NISSEI 若确需新增独立留样目录，只提出具体最小授权请求，不影响独立 Ticket。M6_YIZUMI 的不合格上游继续阻塞。
6. 记录至少两个独立生产 Ticket 的真实 Codex 开始/结束时间、Worktree、Native Session 和 Manager 身份，证明时间重叠。完成 Reader API/CLI、Mold 页面/API 和跨仓数据结构验收后，才报告真实业务交付与后继自动放行。

本次交付覆盖获批 Ticket 正常继续的最小主干。上述历史边界和生产授权条件明确保留，供合并前审查和业务验收使用。
