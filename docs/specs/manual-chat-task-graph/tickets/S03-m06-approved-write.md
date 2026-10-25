# S03：M06 已有授权真正生效，原会话能编码和运行验证

**What to build：** 明确继续实施后，M06 原 Agent 使用已有 Reader 授权，在绑定正确基线的隔离工作区
完成一次实际源码编辑和针对性验证，用户在原话题看到结果。平台不再让它重复申请同一目录，
也不因主对话正在聊天就判定 Reader 已被全盘写占用。

**Blocked by：** [S01](S01-manual-chat.md)、[S02](S02-m06-conversation.md)。前者隔离主对话所有权，后者保证接续错误有正常对话出口。

**Status：** in_progress；2026-10-25 修复已部署，真实授权挂载预检通过；原 Agent 业务编辑及 S02/S03 真人统一验收待完成。见 [571 验证报告](../../../571_REPORT_20261025_S03已批准目录隔离写入验证.md) 与 [572 交接](../../../572_HANDOVER_20261025_S03隔离写入上线与统一验收.md)。

**仓库与基线：** 平台 `/data1/code/agent-platform-v2` @ `ebbce344249e7c270f6d7f4a2fdc681188c6375e` 加 S01/S02；
Reader `/data1/code/hmi_data_reader` @ `e9622681f765cbe0e1319696695f233f4c98c529`；
Mold `/data1/code/mold-data-webpage-tool` 候选 `88e27df989d226003597fd0829b55257174ee11a`。
固定输入与原 Native Session 见 [spec](../spec.md)。业务基线不得替换成共享仓当前 HEAD。

**默认环境画像：** 平台隔离 PostgreSQL/Bubblewrap，M06 现有项目 Python/OCR 环境；源码修改使用独立 checkout。

## 验收项及验证命令

- [x] 旧只读声明与已有补充写授权合成为一个明确的有效能力方案；真实 sandbox 中授权源码目录可写，受保护输入和 Git 元数据仍按角色规则保护。
- [ ] 源码新增、修改、读回在真实 harness 内成功；保存最终挂载、授权版本、checkout、Native Session 和运行关联。
- [ ] 资源接续保留原身份、工作目录合同和未完成工作；旧 claim 变化通过明确核对记录处理，不改审批人、不静默转投新 Session。
- [x] Reader 编辑位置以固定提交建立隔离 checkout；把原批准目录到实际 checkout 的映射告知原 Agent。
  旧共享目录授权已充分覆盖时沿用它；若改变正式交付范围，按 S04 的追加范围确认，不能假称目录批准等于跨仓交付批准。
- [ ] 主对话正常交流与 M06 实施可同时进行；两个真实重叠写作者不能同时认领。权限范围与写占用分开建模且都有执行边界，不能只删除保护检查。
- [x] 历史运行数量增加或慢进程观察不会把启动卡在 5 秒事务内；观察后身份变化仍拒绝错误认领。
- [x] 权限实际应用失败时明确记录失败，不显示 effective，不自动反复启动同一失败尝试。

补入完整申请继承→工作区→真实挂载→原会话写入回归，运行：

```bash
node scripts/sandbox-postgres-session.mjs run task-resource-runtime task-resource-runtime-safety task-resource-graph task-resource-writers task-resource-concurrency
npm run test:codex-app-server
npm run check:long-files
```

真人演示：在明确获准的 M06 实施续接中，由原 Agent 对保留的缺陷候选做实际编辑并运行一个针对性回归，
卡片报告写入位置、命令、结果和未完成项。不能用宿主 touch 成功或一次空写探针冒充业务实施。
本票以“已能实施”验收；正式业务通过与汇合留给 S04。

## 保持不变

不覆盖 Reader/Mold 共享原仓修改，不修改历史固定输入，不以关闭沙箱或扩大数据库超时作为方案。
审批撤销、目录真实身份、单写者、锁内身份重验、原会话和固定候选边界保持有效。


## 本轮证据边界

实现 8dec908，合入部署 911558d。上方打勾项有自动回归及真实挂载预检支持；未打勾项包含原 Agent/真人业务证据，仍须统一测试。
真实预检仅写入并删除权限探针，checkout 保持干净；实际源码编辑和针对性命令来自隔离 fixture，不能冒充 M06 业务实施。
生产旧申请 approved/application failed 保留，新轮按已批任务资源继承并记录新应用结果，不重复申请目录或改写旧 claim。
