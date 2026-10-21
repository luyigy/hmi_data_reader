# 原 Reader/Mold 路线的真实接续

路线 `cmvdmf87w043f9xhgf9yvua6p`。授权来自真实飞书用户消息 `om_x100b62b9b8ae94a0cf2b420b2814528`，转发时保留原消息身份及来源；未伪造用户消息。运维说明不是授权，最初未认证的说明已追加拒绝回执。

## 已观察到的业务结果

- BOLE：原 Session 自动接回独立验收发现的 HTTP500/CLI 崩溃。修复后固定候选 `4762630515d354c4bbe1086bbeecb3e3a2f78f6a` 独立验收通过。完整报告见 `bole-independent-acceptance.txt`：裁剪图 API 明确返回422及拒识原因，CLI落盘 reject；完整授权图通过实际 OCR、API、CLI、新进程读回及冻结合同校验。没有把未知代际或未支持版式宣布成功，也不代表 Mold 页面已验收。
- ARBURG：原 Session 实施及受控合并后，独立验收发现真实原图 `50.0` 误读为 `500.0`；平台自动回到原实施者修复。00:34快照中正在执行，未宣称通过。
- FANUC：历史混合格式证据通过严格解码及真实 Git 复核后进入受控冲突修复，00:34正在原 Session 执行。
- YIZUMI：第一轮接续保存四个业务文件并报告17项测试；已批准表实际浏览找到5条记录、机台值30，无需用户搬图。真实查询回执绑定执行、claim、policy hash、记录号及响应摘要写入原账本；原恢复入口已继续同一 Session，00:34正在执行。
- NISSEI：同一原 Session 已查询至1520条已授权记录；独立样本资格仍不充分，6项通过、1项失败。只读访问未授权的 hmi_finetuning 日精 Z077/Z078 原图及来源分组元数据需用户确认。没有扩权或伪造验收。
- M6_DEMAG：BOLE通过后，原“夹带未通过历史交付”检查已解除。继续预检发现批准 Reader 固定提交 `d682493504f778c7830c50b594326e6bbbb6fcfa` 含1170文件、274336002字节，超过旧256MiB硬编码容量。不得删输入、改变固定提交或改成直接读取主仓。

## 兼容修复及测试

正常 implement/waiting_for_user 支持经过认证的显式继续；不重置无进展计数。Writer alive/unknown 时保留已提交恢复请求，等真实退出后才领取，执行时仍检查 Writer 和 CAS。已记录工作目录被删除时，仅允许在记录路径不存在、Git无其他登记、保存分支恰好仍指向固定候选时重建。原 Session 引用仍保护工作目录不被自动清理。

`node scripts/test-task-graph-postgres.mjs persistent-ticket-agent-t1 task-graph-implementation-recovery task-graph-worktree` 通过。旧版 normal wait 恢复失败和修改后证据保存在本目录；legacy用例期望已同步现行“原执行 inbox、Session保留目录”行为，未恢复独立只读 Followup。

## 固定输入容量

`upstream-source.ts` 使用宿主配置 `TASK_GRAPH_UPSTREAM_MAX_BYTES`，默认仍为268435456。必须是正安全整数；预分配前、缓存复用及物化后使用同一容量校验。此设置只控制完整固定输入副本的磁盘容量，不赋予文件、网络或项目权限；原 Git commit、blob身份、模式、文件清单、符号链接/LFS拒绝、文件数量上限及只读沙箱保持原样。不要与 Ticket 重试预算混用。

本宿主已在 systemd drop-in 设置 `536870912`（512MiB）。原固定 Reader 提交已完整物化并通过 Git 内容与容量校验，M6_DEMAG 已通过原恢复入口进入 ready 队列，输入准备回执 SHA256 为 `a043da2c5f67e0ff4d0a4fc3dace655254dd90a8c82c3c2880262b7c603b296d`。当前三项 Codex 仍在执行，Coordinator 正按原退出流程 drain；配置已写入不代表运行进程已更新，详见 `capacity-deployment-receipt.json`。

`node scripts/test-task-graph-postgres.mjs task-graph-upstream-capacity task-graph-upstream-inputs` 通过：旧代码忽略宿主容量的反例为红；修改后容量越界在分配前拒绝、精确边界可用、Git内容一致、缓存重新核对、非法配置拒绝。原跨仓固定输入、只读双环境、未通过交付拒绝、缓存重建及前置派发门禁继续通过。新增用例注册现有必跑集合。

## 部署边界

平台提交已按追加历史合并。Coordinator通过已有SIGTERM/AbortController停止派发并等待inflight完成，由原systemd服务自动启动新进程；没有systemctl stop的20秒强杀，也没有热补丁加载器或第二个调度器。第一次已于2026-10-22 00:33:51 CST真实重载到04e46c2，节点运行身份见 `live-status-20261022.json`。容量配置后的第二次重载另存回执。

真实 Sandbox Manager 的完整70文件技能包读取、校验脚本及源码不可写预检见 `sandbox-preflight-receipts.json`。这些不替代业务验收。`npm run build`（包含W001与真实Codex本地协议夹具）、TypeScript及长文件守卫通过。未恢复新的平台改造路线，未清空生产预算或修改批准快照。
