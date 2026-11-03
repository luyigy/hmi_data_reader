# 飞书回复卡片 Markdown 表格渲染修复

## 问题与方案

用户反馈普通回复的 Markdown 表格在飞书显示为管道符原文。基线 e803bc5：普通聊天进展卡、转发卡和等待/兜底卡没有 schema，使用旧版 elements；任务运行卡已使用 Card JSON 2.0。新版富文本支持 Markdown 表格，沿用原文即可，无需自写表格解析器。

官方依据：[富文本表格语法](https://open.feishu.cn/document/feishu-cards/feishu-card-cardkit/components/markdown?lang=zh-CN)、[Card JSON 2.0 富文本](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text)。原生富文本表格默认每页五行、单组件最多四表，仍受飞书客户端与卡片容量限制。

在隔离 worktree feishu-reply-card-v2-20261103 实施：普通回复链路统一 schema=2.0 / body.elements / update_multi=true / width_mode=fill；替换旧版 note，保持标题、思考/工具折叠区、运行脚注和单卡生命周期。原文、代码块、链接及平台历史消息不改写，不迁移审批卡或其他管理卡。

## 实现

- FeishuProgressTracker 的进展、成功和失败卡使用 2.0。
- assistant relay 卡使用 2.0，角色、交接和脚注改为 notation/grey 的普通文本 div；移除不参与行为的 chatType 参数。
- 等待卡、最终兜底和失败恢复都使用 2.0。兼容读取已有 elements/body.elements，并转换残留旧 note。
- 脚注标记 reply_footer，最终答复更新脚注时替换旧脚注，避免重复。
- 共用展示函数新增 replyCardNote。任务运行卡保持原有 2.0 行为，只为脚注增加稳定标记。

## 验证

1. 用户原表格的回归用例在修改前失败：schema 为 undefined，而不是 2.0；修改后通过。覆盖最终回复、转发和任务运行卡，保留表格与 fenced code 原文，重复序列化幂等，卡内无旧 note。
2. unified-turn-card、feishu-live-room-relay、feishu-progress-system-info、live-room-footnotes、session-size 回归通过。
3. `node scripts/sandbox-postgres-session.mjs run feishu-turn-card` 通过。使用独立 Bubblewrap PostgreSQL 实例与临时 schema，覆盖等待卡、反序完成、丢失回执、PATCH 失败、重启恢复、取消队列和话题隔离，验证新版卡片没有打破单卡生命周期。
4. TypeScript 全量检查、改动源文件/新增测试 ESLint、长文件守卫与 git diff --check 通过。
5. 飞书 CardKit 实际创建包含用户表格的未发送验证卡：HTTP 200 / code=0 / success，card_id=7703826071309880580。未调用消息发送接口，未向聊天发送测试消息。此项证明服务端接受卡片结构，不冒充客户端截图验收。
6. GitNexus 定向影响检查与源码核对，影响集中在普通聊天回复和共用脚注；路由、审批和调度未变更。

未发送卡片验证回执位于 worktree 的 output/623-card-validation.json；数据库测试证据位于 output/sandbox-postgres-runs/2026-11-03T141841-2830583/。均为忽略的运行产物。

## 生效

追加提交并 fast-forward 合入运行目录。通过 output/623-reload-feishu.mjs 在 TaskRun、定时作业和 delivery 均空闲后重载飞书服务；状态记录于 output/623-reload-feishu.json。当前轮不强行中断，ready 后的新回复使用新版；历史已发送消息不批量重写。

## 修改文件

- src/lib/agent-reply-card.ts
- src/lib/feishu-live-room-relay.ts
- src/lib/feishu-progress.ts
- src/lib/feishu-turn-card.ts
- tests/feishu-reply-markdown.test.ts
- tests/feishu-live-room-relay.test.ts
- tests/feishu-progress-system-info.test.ts
- tests/feishu-turn-card.test.ts
- tests/unified-turn-card.test.ts
- 本报告
