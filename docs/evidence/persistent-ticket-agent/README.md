# 持续 Ticket Agent 手动实施结果

实施分支：`fix/persistent-ticket-agent-manual-20261021`。合同：`docs/architecture/527_ARCH_20261021_PersistentTicketAgentContract.md`。主仓 `oss-prep@bac31f2` 未合并或部署本轮代码。

用户发现新路线 T0/W01 没有完成预期推进，明确要求停止使用任务图，当前会话手动实施。本报告区分代码回归、实际运行控制和仍未执行的业务验收。

## 本轮结果

| 范围 | 代码与证据 | 当前结论 |
| --- | --- | --- |
| T0 用户暂停 | 1ab7ca6，run-control.ts、Stage/领取/消息消费门禁；t0.md | 实际新旧路线已用户暂停，均无活跃 Turn。候选、批准、Session、预算保留 |
| W01 工作区 | 4568904、2032caf、5c5ee3e，workspace-layout.ts、git-worktree.ts、worktree.ts；w01.md | 新工作集中目录，旧路径兼容。历史目录只读盘点，没有盲目搬迁 |
| T1 原 Agent 连续工作 | a4aee4e、6e1b482、3818eb1；t1.md | 普通进度/非完整报告继续实施；明确等待后正常回复接回原 Session。保留空转和资源保护 |
| T2 验收反馈/冲突 | 822c2cb；t2.md | 超过原固定两轮仍可在范围内修复；每次新候选重新验收。大 diff 使用等价流式指纹 |
| T3 总览和回复 | 4f93adb；t3.md | 父卡分页、问题呈现、定向回复、幂等与操作权限完成隔离测试。真实飞书客户端仍待验收 |
| Node 预加载 | 82a744a；node-preload.md | 修复真实 Bubblewrap 内已挂载依赖仍找不到 -r 模块的问题；不增加挂载或宿主回退 |
| T4 原 Reader/Mold | manual-takeover-snapshot.json | 仅保留与复查，未生产恢复，不能宣称业务已经自动交付 |

## 用户可见行为的回归

T1 使用真实 Coordinator、隔离数据库、Git Worktree、检查命令。外部模型 Adapter 为夹具：正常多轮、明确等回答、重复消息只消费一次、同一原生 Session 和目录完成交付，随后释放后继；普通轮次不消耗错误类别预算。调查过程中实际新工具操作计入工作，相同工具预览与模型文案不计作新进展。

T2 的四个固定候选分别进入独立 Review，三个不同缺陷回原实施者，最终通过后只释放一次后继。相同候选树/输入/失败重复时停止空转；原计数没有清零。真实 Git 冲突与迟到结果仍受旧权威门禁保护。

W01 用真实安装的 Codex 程序、真实工具与 Sandbox Manager，模型服务为本地确定性 SSE。首次和续接 threadId 相同，两个 bwrap 根进程关闭；同级工作区不可读，Git 元数据不可写。这不是实际模型与飞书的端到端验收。

T3 只把操作员已鉴权的定向回复转入原房间/inbox；卡片不是第二个工作状态权威。撤掉实际操作员权限检查的反向验证失败，恢复后通过。原 Topic 一键深链尚未提供，卡片内可以定向答复，深入交流仍使用已有 Topic。

## 安全与兼容验证

- W001 源码/AST 和真实变异门禁仍执行，旧 Resume 输入、权限、输出目录、候选身份与绕过验证均被阻断。
- 原 Writer 检查保留。并行构建期间一次观察因 /proc EACCES 返回 unknown，未放宽或伪造为退出；构建退出后的原 Manager 用例通过，nonce 后代存活仍被识别。
- 旧 result-recollection 用例原先强制两轮非协议输出即 exhausted；与批准的新合同冲突，已改成验证连续实施、停止无进展空转以及不得假交付。
- TypeScript、长文件与 Next 生产构建检查通过，最终构建证据 final-build-green.log；最终 T1/T2/T3、调查进度和身份测试见 final-manual-slices-green.log。安全兼容最终进程 exit=0，关键输出及此前失败见 final-safety-results.log。构建不等于部署。
- 全部数据库行为测试只使用现有脚本新建的隔离 schema，结束删除；没有在生产 public 中执行测试夹具。

可复核命令：

```sh
node scripts/test-task-graph-postgres.mjs persistent-ticket-agent-t0 persistent-ticket-agent-t1 persistent-ticket-agent-t2 persistent-ticket-agent-t3 task-graph-check-node-environment
npm run test:persistent-ticket-agent-w01
node scripts/test-task-graph-postgres.mjs task-graph-stage-authority task-graph-writer-ownership task-graph-sandbox-manager task-graph-result-recollection task-graph-conflict-continuation task-graph-targeted-repair task-graph-review-platform-retry task-graph-interactive-conversation
npm run build
npm run check:long-files
```

原生沙箱类回归应避免和另一组原生构建夹具同时运行，以免宿主进程观察因短暂不可核验返回 unknown；任何 unknown 仍须保留并调查，不能用重试次数伪造退出。

## 仍需完成的发布与业务验收

1. 固定本分支提交做最终审查；只在批准后合并、部署并确认服务实际加载提交。
2. 使用全新专用路线，经真实飞书批准卡，验证真实 Codex 并行、正常补材料、原 Session 续接、验收反馈、总览回调与后继释放。当前没有创建或启动新的自动路线。
3. 旧 Reader/Mold 保持用户暂停。T4 在明确恢复授权后，逐项验证合法保存点、授权来源/Runtime Pin、候选、Writer 与 CAS；现有历史 exhausted 的平台验收不能直接改 ready。旧 source.commit 与平台代码身份混用的兼容风险仍待该阶段验证，不能以新路径回归通过冒充已经解决。
4. 业务验收展示 Reader 实际输入与 API/CLI 结果、Mold 页面和保存回读、跨仓合同一致性、真实独立验收与后继放行。未执行这些之前不报告生产交付完成。
5. 历史目录需要按清单证明 Writer、Session、账本和绝对路径引用释放，保存独有提交后再迁移/回收。脏目录与忽略内容先保留。

没有启用旧 watcher、没有新建后台 Agent/数据库状态机，没有恢复生产 Ticket或修改旧批准快照。普通消息和验收缺陷不再依赖新造的恢复 Prompt 协议。

## 2026-10-21 发布更新

用户随后明确批准部署。代码已通过追加合并提交 0423f11 进入 oss-prep，并推送 Gitee 与 luyigy；主仓生产构建通过。网页服务与 Coordinator 已重启，HTTP 健康检查通过。飞书接入和总览 relay 由现有空闲重载脚本在当前会话结束后切换，当前保存的 deployment.json 如实标记 waiting_for_current_turn_to_finish。最终切换回执位于该 JSON 指定的 output 路径，应在下一轮核实 completed 与新飞书 startedAt 后才宣布全部服务部署完成。

T0、W01、T1、T2、T3 的代码已经手动完成隔离回归，任务图账本没有冒写通过。T4 旧 Reader/Mold 恢复和真实业务验收未做；两条路线继续保持用户暂停。
