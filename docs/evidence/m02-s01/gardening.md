# S01：M02 输入修复与受控自动接续

Run：`cmvdmf87w043f9xhgf9yvua6p`。范围为 M02；没有恢复 R05，也没有修改 Reader 原仓或 R02 已验收提交。

## Failure

M02 已通过浏览器验证，仍以 `missing_upstream_input` 停在 `attention / waiting_decision`。卡片标为平台负责、无需用户决定，但协调器没有消费平台准备成果的入口。反复恢复同一输入不能补齐交付。

## Root Cause

实际复现了以下缺口：

1. R02 归档的绑定验收包使用测试 profile，Model 已审解释引用正式 `b_and_r.injection_holding.multi_stage_position_time`。原补救草稿又缺少登记提取器字段，Reader 管理接口真实返回 422。补登记信息后，隔离 Reader 的 draft、trial、publish、GET 全部通过；旧 0.1.1 内容不变。Model 原版本锁真实拒绝新 0.1.2，补充精确版本哈希后通过。
2. `pauseGraphImplementation` 将缺前置输入转为 `decision_required`，现有循环不会自动领取 attention。准备成果此前没有绑定到原 claim、revision、候选与失败事实的受控交接。

3. 首次真实 OCR 测试只断言 Reader 原屏字段和选页保存，没有断言 Model 候选非空。独立验收指出绑定后仍读默认解释版本，并误把控制器 B_AND_R 与品牌 BOLE 比较，候选为空。14 项通过不能证明这条业务链完成。
4. 验收拒绝已持久化，但即时回修事务因写入者退出证明未就绪而回滚。协调器没有在退出确认后重拾这份当前验收结果，留下 integrated execution 与 attention 节点。保留写入者守卫，需要补持久交接。

Reader 发布探针运行在冻结提交 `cd92faeb2cfb86486fc9b65d2053e50a31fede2f` 的隔离副本，不是向生产 Reader 发布。新包的业务候选与旧已审 s01.2 完全相同；Model 审核新增固定版本，不增加业务语义或人工真值。

## Wire

- Model 原 M02 检查入口纳入实际正式包、真实版本锁和 CPU OCR 到 Model 持久化回归。缺固定输入或运行能力时失败，不静默跳过。保留 0.1.1、旧默认版本、原始照片哈希和 unknown 状态。
- 平台登记哈希绑定的准备回执，现有协调器调用原恢复函数。登记不改 ready；消费在原节点锁内重验 revision、claim、TaskRun、候选、依赖提交及文件字节。旧写入者未退出、成果改变、显式业务决定、范围/权限变化和耗尽状态均不能通过。
- 授权直接读取原始失败字段，不使用卡片展示函数推导。一个准备回执发生临时基础设施故障时保持待处理，后续回执仍可推进。

- 当前独立复核结果的回修交接单独处理。周期仅拾取 integrated 且绑定仍有效的已完成、范围内失败复核；在原节点锁内复验候选、revision、结论及证据，再调用原回修入口。未知写入者继续等待，不删退出保护。仅目标执行回修，成功兄弟保留。

## Verification

- `prepared-recovery-red.log` 是禁用消费者后的受控变异，断言得到 `attention` 而非 `ready`。恢复消费者后同一测试通过，不声称这是历史提交二分。
- `preparation-boundary-red.log` 用真实首版 `07b9e7c` 加入新反例，捕获展示层误改授权的问题；追加修复后的三组 PostgreSQL 测试通过，包含 EIO 后同 Run 后续回执继续、重复/崩溃回放、过期绑定、文件篡改、未知/活跃写入者及预算不变。
- Model 新包检查在旧输入上报 `Reader page package version unavailable`；补救后原入口 14 项通过、零跳过。主控又用实际 `runSandboxedGraphCheck`、只读源码和固定输入执行，同样 14 项通过。
- 原测试控制器与正式 B&R 包的 1440/390 双视口测试共两项通过；实际保存、独立 GET 与重开。使用隔离会话 cookie，不冒充测试网页登录流程。
- `review-repair-red.log` 禁用交接消费者，复现退出后仍 integrated；green/final 覆盖退出后恰好一次自动回修、无人工恢复、成功兄弟已用预算不影响目标回修、过期候选/结论/证据及人工决定保护。
- TypeScript、长文件和差异检查通过。测试数据库使用独立 schema 或一次性 SQLite，没有清理共享数据库。

## Scope

平台入口仅支持单 execution、实施阶段、平台负责且无需业务决定的 `missing_upstream_input` 或明确 `missing_capability`。不增加调度器、数据库表或 Agent 角色，不重置预算。

准备度为 `local_operator_attested`。平台核对回执绑定和文件哈希，不把日志哈希等同于独立业务验收。运维仍须完成准备核验；本次主控实际运行了只读沙箱检查。此入口不自动发现或修复所有环境、业务材料问题。

业务补救是 B&R 单页的已有迁移兼容路径，保留部分语义核实和未知段态。没有开放工艺参数自动写入，也不表示 raw v2 或所有品牌完成。

## Live Result

2026-10-19 18:19，协调器消费准备事件 `cmvf3rqot0003f9765nlg474x`，生成恢复事件 `cmvf3rs8e00bwcal4t2be1h5f`。新 TaskRun `cmvf3s0r400e9cal43be8exba` 自动启动，原生进程 339800 存活；原话题卡 `om_x100b627b2c66b8a8cfdc68e18b8a39f` 复用，四类计数仍为 0。

本次人工恢复命令调用次数为 0，只登记了一份核验过的准备回执。底层仍复用既有 `operator_resume` 状态转移，不把它误报成没有发生恢复。当前这项记录只证明接续启动，最终集成与独立验收结果须另附账本回执。

首次集成提交为 `e34d0e3ecf266909e1c72c2e737c713523e7e304`。独立验收 TaskRun `cmvf3wev4023bcal4rbov5evd` 拒绝空字段候选，事件 `cmvf41jsp03zjcal4zgcy565m`。回修事务随后失败，计数仍为 0。18:34 再次确认实施和验收进程均已退出。此处明确记录失败，不将测试通过或集成等同于验收通过。

18:36:41 在所有旧写入者退出且无任务运行时加载补丁 `0567138`，只重启任务图服务。主飞书 PID 保持 21469。18:36:47 自动生成 `node_repair_scheduled` 事件 `cmvf4dkpl00096wx4zruea1gu`；18:37 新原生实施 TaskRun `cmvf4dtys002i6wx4xshuy4er` 启动，仍用原卡。代码回修计数为 1，其余计数为 0。没有新增人工恢复请求。当前正在修业务候选和补断言，尚未再次通过独立验收。

## Follow-up

先验证 M02 集成、独立验收和后继自动释放，再根据真实失败扩充准备处理范围。Gardening 不作为后继的新门禁，不为每票强造新 Wire。

独立边界审查使用 GPT-6-astra，发现并推动修复两项阻断问题。可用审查模型均属 GPT 家族，未声称跨模型家族审查。GitNexus 因共享索引不可读未能提供影响图，未重建索引；实际调用路径与差异由源码导航及回归复核。
