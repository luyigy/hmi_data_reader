# Workflow 凭据失效与重复通知修复

## 现场和结论

用户报告机台数据采集群 `oc_bb599d4608ff895a5dfae3d1fb49107a` 的 `tb-feishu-alarm/workflow-watcher` 创建 037 PLAN 审批卡失败，同时重复发送“workflow validator 通过”。

这是两个问题叠加：宿主 Lark CLI 的应用密钥无效，导致文档创建失败；工作流消息去重键放错请求位置，重试产生重复通知。不是该步骤在 Agent 沙箱中缺少挂载，也不需要用户重新 OAuth 登录。此前 624 中的其他沙箱未决问题仍未整体解决。

## 凭据诊断与现场修复

- ScheduledJobRun 保存的完整错误为 `identity=bot / type=config / subtype=invalid_client / code=20002 / The client secret is invalid`，卡片原来只展示了外层 Command failed。
- `importMarkdownAsFeishuDocument` 在宿主临时目录执行 `lark-cli docs +create --as bot`，继承 watcher 环境，不经过 Agent Bubblewrap。
- hello 终端、scheduled-jobs 和 feishu 服务的环境分别执行 `auth status --json --verify`，均得到 Bot verify_failed。CLI 命令本身可能退出 0，因此必须检查 identities.bot.verified，不能只检查退出码。
- 两个服务的 FEISHU_APP_ID 均为 `cli_a8e5326f4e7f901c`；用各自环境中的 FEISHU_APP_SECRET 获取 tenant token，均为 code=0。平台凭据有效，CLI 凭据来源失配；尚未查明 CLI 密钥何时、被谁修改，不推断为 TaskGraph 导致。

已使用 CLI 的 `config init --app-id … --app-secret-stdin --brand feishu`，通过标准输入写入平台已验证有效的同应用密钥。未把密钥放入命令参数、日志或仓库。保留原 config.json 的应用/用户选择；init 改动配置后恢复其原始字节，密钥更新留在 CLI 加密存储中。未执行 auth login、未创建新应用。

原 config.json 和该应用加密凭据文件备份于 `/home/hello/.local/state/agent-platform-repairs/lark-credentials-20261106-092229/`，目录 0700、文件 0600，不进入 Git。修复后按 watcher 环境验证 Bot 为 ready / available=true / verified=true，应用和 Bot 身份保持一致。

## 重复通知的原因及修改

watcher 在文档创建前发送校验通过通知。文档创建抛错时，runner 事务不保存新的 cursor，下一分钟仍扫描同一 PLAN；该项目 schedule 为每分钟一次。失败后的重试本身用于恢复工作，但已发消息需要单独去重。

`src/lib/feishu-api.ts` 的 `sendFeishuWorkflowMessage` 原来把 uuid 放进 URL query；发送消息接口要求它位于 JSON 请求体。现将原有稳定 idempotencyKey 放入 body.uuid，receive_id_type 仍留在 query，其他消息内容、事件键和审批逻辑不变。覆盖工作流文字、PLAN 审批卡和退回反馈卡的共用发送入口。

依据：[飞书发送消息接口](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[飞书官方 SDK CreateMessageReqBody.uuid](https://larksuite.github.io/oapi-sdk-java/com/lark/oapi/service/im/v1/model/CreateMessageReqBody.Builder.html)。相同 uuid 的服务端去重窗口为一小时；本补丁修复每分钟重试的错误传参，**不是永久通知账本，也不保证超过一小时的故障绝不重复**。候选 HEAD 改变还会影响现有 eventKey；本次未扩大为持久化副作用账本或改变游标合同。

源码提交 `ccd0a10`，隔离 worktree 为 `workflow-notification-uuid-20261106`。修改：

- `src/lib/feishu-api.ts`：uuid 从 URL 移入 body。
- `tests/workflow-watcher.test.ts`：真实 watcher 到 fetch 边界校验 uuid 位置和非空值；覆盖文档导入失败后的重复校验通知复用相同 key、审批卡使用不同 key；原完成回执重试断言改读 body.uuid。顺手移除一个已有未使用局部变量，使该文件 lint 通过。
- 本报告。

## 验证和生效

新增断言在旧代码上失败，错误为 `message uuid is a body field, not a query parameter`；修改后 `npm run test:workflow-watcher` 通过。测试包含临时 Git 仓库的历史改写拒绝用例，输出 blocked non-fast-forward 为该用例的预期日志，不是在主仓改写历史。

TypeScript 全量检查、两个改动文件 ESLint、长文件守卫和 diff 检查通过。GitNexus 对共用发送函数的 upstream 分析为 LOW，直接调用为工作流文字、审批及反馈卡；提交差分检查也为 low。没有向群发送额外测试通知。

凭据修复后，既有调度自然重试成功：2026-11-06 09:23:06 CST 开始，09:23:12 完成，summary 为 `gate=plan_review document_ready=true card_sent=true`。该次成功发生在代码重载前，证明认证故障已消除。

- PLAN：`docs/037_PLAN_20261106_样本卡片与报警反馈.md`
- 业务仓提交：`1dc9f0d44f91453b851f596a79f3b11d6c7e1bbf`
- 文档：<https://ecn6lj2fknte.feishu.cn/docx/OuPYd2Wh2oKMsOxiv1tcheppnqc>
- 审批消息：`om_x100b61e68eca6d00c04b43772bc4f3a`
- 已通过消息读取 API 确认目标 chat_id、interactive 类型、未删除且包含该 PLAN 标题。

补丁 fast-forward 合入 oss-prep 后，确认无 running ScheduledJobRun，重启了 `agent-platform-scheduled-jobs.service`，PID 2070134 → 1083191，状态 active。未创建临时 systemd 服务，未重启飞书主服务、未手工推进 cursor 或代批。定时 watcher 已加载补丁；飞书常驻进程内的同名共用函数仍需下次常规重启加载，不把源码合入等同于所有进程已重载。

恢复时审批状态为等待人工审阅。通知里的“Slice / 计划进度未声明”是文档元数据展示，不是本次创建失败的原因；`start_first_slice` 是待审批计划的动作字段，不表示已经自动批准或开始实施。
