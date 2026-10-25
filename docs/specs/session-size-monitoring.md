# 会话记录大小与脚注提醒

2026-10-25，Feishu DM 08a216 用户要求统计每轮会话大小，并在过大时提醒重置；追加确认把统计和提醒放在卡片脚注。

## 展示与口径

- 主对话和任务图话题使用同一脚注：会话记录累计 MiB、本轮新增 MiB、采样时间；超限追加 ⚠️ 重置提示。不增加独立消息，不自动清空会话，不阻止运行。
- 统计原生 Codex Session 的主 rollout JSONL 文件字节长度，1 MiB = 1,048,576 字节。包括已保留的历史与压缩事件，不表示当前模型上下文或账单 Token，也不合计其他 Session、附件、子 Agent 记录。
- 本轮增量为同一文件在执行前后之差；新 Session 从零统计。续接前缺少基线、文件被替换或观测到缩小，增量显示未知；文件缺失、身份不符或重复记录不能冒充零值。
- 本机 Codex 首次启动和续接都采集：运行前建立基线，确认 Session 后采样，运行中每 30 秒采样，成功、失败或异常退出的正常收尾再次采样。强制杀死进程时只能保留最后一次已保存的观测。
- 当前支持 Platform Local Codex；其他 harness / 远端执行、ephemeral Session 无原生文件采样时明确显示未采集，不把平台 stdout 大小冒充原生会话大小。
- 采样只读取文件属性和最多 64 KiB 身份头，不读取整份历史。每次运行查找一次文件；新文件暂未建立时下次采样重新查找。

## 提醒阈值

默认累计达到 10 MiB 提醒，达到 20 MiB 强提醒；之后每轮持续提示保存交接并重置当前 Agent 会话。旧卡保留当轮观测，新 Session 单独计算。提醒在脚注优先保留，避免其他遥测过长时被截掉。

配置项（负责执行和卡片展示的服务应一致）：

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `AP_SESSION_SIZE_WARN_MIB` | 10 | 提醒阈值 |
| `AP_SESSION_SIZE_STRONG_MIB` | 20 | 强提醒阈值，必须大于提醒阈值 |

值须为正的有限数，最大 1,000,000 MiB；阈值顺序无效时整组回退到 10 / 20。配置不影响实际采样字节。

这是使用提醒策略，不是已测得的性能安全线。只读采样当前 CODEX_HOME 的 sessions 目录：1,087 份记录，中位数约 0.32 MiB，5 份达到 10 MiB，1 份达到 20 MiB，最大约 196.25 MiB。样本包含历史和短会话，不能由此推导模型延迟或上下文容量；10 / 20 用作初始可配置策略。

## 身份与投递

采样保存到 TaskRunParticipant.controlMetadata.sessionSize，绑定 runtimeExecution.id、participantId 和 lastSessionId。新执行清除旧观测；写入按 controlMetadata 比较更新，拒绝旧执行、错 Session 和乱序观测，保留其他元数据。无需数据库迁移。

运行中主对话通过回调更新原卡；任务图展示服务检测新采样时间，因此即使没有新输出事件也能更新同一卡片。正常结束、持久卡恢复继续通过共用脚注读取已保存观测。

## 验证与生效

- `npm run test:session-size`：真实临时文件、压缩历史、大小边界、重置、路径身份、256 MiB 稀疏文件；实际 Codex adapter 的启动/续接失败收尾（模型执行使用夹具）、元数据竞争和旧执行隔离；两种卡片 schema 的脚注提醒与容量边界。
- `FEISHU_APP_SECRET='' npm run test:task-graph-postgres -- task-graph-feishu-relay`：隔离临时数据库，模拟飞书 API；无新输出事件时阈值变化更新原卡，重复采样不重复投递。
- 既有 live-room-footnotes、unified-turn-card、live-room-progress、codex-runtime-state 回归；`npx tsc --noEmit`；长文件守卫。

服务加载新代码后，新一轮执行开始采样；部署前已经启动的 Agent 不会凭空拥有本轮基线。历史卡片不自动补算。需要加载新代码的进程包括主飞书、任务图执行和任务图展示服务。
