# 持续 Ticket Agent 执行包

需求和依赖唯一来源为 issues.json 指向的 Gitee Issues；本文件不是派发协议。
spec-package.json 只登记执行配置，依赖不在本地重写。Issue 发布、分支推送均不代表已启动。

T0 与 W01 无业务依赖；T0 → T1 → T2/T3；T2 + T3 + W01 → T4。
平台代码集成目标为 feat/persistent-ticket-agent-20261021，不直接更新生产 oss-prep。
每项固定 ticket-behavior 检查在基线缺失，属于实施者必须交付的真实行为回归，不能用跳过检查代替。
现有必跑 W001 与长文件门禁同时执行，Agent 独立验收必须核对对应 Issue 的完整行为和实际证据。
生产部署、旧路线维护暂停的实际操作与最终恢复分别需要明确授权，不因本卡批准开发就自动执行。
