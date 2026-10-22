# 普通材料等待后的原生 Codex 续接验证

源码基线：`1760fad`。本次增加隔离原生 smoke，不修改平台业务实现。
536 的全面收敛尚未实施，本报告只验证用户指定的最小路径。

## 验证范围与结果

真实本机 Codex adapter 与已配置模型执行两轮，没有模拟模型响应或 shell 写文件。
第一轮任务缺少返回数值，Codex 提问并报告 waiting_for_user；工作区 answer.js 保持原样。
隔离数据库内原任务房间收到一条带 Feishu 来源的普通用户消息：
“返回数值使用42，请按原任务完成。”
经 receiveGraphRoomMessage、conversation inbox、Coordinator 正常领取，第二轮原生 resume
实际修改文件，执行 Node 断言，并由平台检查与受控集成保存成果。

- 首轮与续接原生 Session 均为 `01a1637c-d13f-7b60-9186-bef288b6bb53`。
- 原 Worktree 保持不变；execute 一次、resume 一次，返回 Session 身份一致。
- answer.js 从 `module.exports = () => null;` 改为 `module.exports = () => 42;`。
- 实际执行 `require('assert').equal(require('./answer')(),42)` 通过。
- 隔离业务成果提交为 `245b3518578d81d9a0bbf3937ff52200556bfe1f`，它不是平台仓修复提交。
- conversation_input_bound 恰好一条；conversation_review_recovery_requested 为零。
- repair/platform/format 三种预算计数均为零，没有执行任何恢复控制命令。

固定证据：[evidence.json](../evidence/native-topic-continuation-20261022/evidence.json)。
临时仓和测试 schema 已由隔离运行器清理，提交 diff 保存在证据文件，不能声称临时提交可从远端获取。

## 可复现入口

```bash
TASK_GRAPH_NATIVE_TOPIC=1 npm run test:task-graph-postgres -- task-graph-native-topic-continuation
```

此入口显式 opt-in，会调用真实模型并产生费用。仅在新建的 task_graph_test_* schema 运行，
工作区位于临时目录。未加入默认全量回归，不向外部飞书发送消息。
可用 NATIVE_TOPIC_EVIDENCE 指定本地证据文件路径。

## 不能混同的验收边界

飞书传输层使用已落库 Topic 消息夹具，尚未验证真实用户从飞书客户端发送消息的全过程。
夹具验证任务房间归属与输入接续，但没有覆盖飞书 webhook、签名、事件接收与真实聊天身份映射。
因此本次是原生 Codex 的隔离端到端通过，不是生产 Topic 端到端验收通过。

本次没有恢复、暂停或改写 Reader/Mold 生产任务，也未部署平台。
BOLE 从总览回复后产生实际代码成果是相邻证据，但不替代用户要求的原 Topic 场景。
真实业务验收还需用户在选定材料等待 Ticket 的原 Topic 发一条正常回复，随后核对
该消息的绑定、原 Native Session、同一 Worktree 及回复后的实际代码 diff。
不能用机器人冒充用户消息，也不能把测试夹具当成用户已完成这一动作。

当前 waiting_for_user 的普通提问路径已经能通过本 smoke。
历史 waiting_decision 的材料交接、原因清理等 536 剩余改造，不因这次通过就视为解决。

## 本轮检查记录

- 原生 smoke 命令退出 0；不是 skip。
- `npx tsc --noEmit --pretty false` 退出 0。
- `npm run check:long-files` 通过，无达到 1000 行阈值的文件。
- 额外执行既有 task-graph-interactive-conversation 回归退出 1：第 89 行
  platformAttempts 期望 0、实际 4。没有改动该回归或平台控制流；尚未定位这项失败原因。
  因此不能报告相关回归全部绿色，也不能据本次 smoke 宣布 536 全面修复完成。
