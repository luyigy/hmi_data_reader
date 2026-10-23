---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: docs/545_PLAN_20261023_运行环境修复手动执行.md
slice: S03
plan_progress: in_progress
---

# S03 完成：阶段服务拥有自己的 PostgreSQL

## 下一 Session 从这里开始

工作目录 `/data1/code/agent-platform-v2-manual-runtime-repair`，分支
`manual/s02-runtime-repair-20261023`。读取 AGENTS.md、545 PLAN、本文；下一单元是
**S04：相同固定资源接入实施与验收**。本轮只完成 S03 的函数级真实服务验收。

按用户授权继续采用手动 HANDOVER，每次一个可验证单元，追加提交后停止。
不启用 watcher、不恢复原 S02_A/S02_B、不部署。本文不包含自动派发指令。

## 本轮实际结果

实施基线为 pi 的 `887e310`。开工前独立重跑 S02：数据库启动、隔离读写、清理可用；
`task-graph-environment-outcome` 仍在第 81 行断言失败。这不作为 S03 的绿色回归，
也没有为了通过测试改变 S05 的业务预期。

- `service-contract.ts` 新增 `PostgresService` 和 `AttemptService`。PostgreSQL 接受
  现有 `RuntimeResource` 的固定路径和 SHA256，不增加资源配置系统。
- `GraphService` 继续只接受来自已消费上游的 Node/Python 服务。图 JSON 不能直接声明
  任意宿主 PostgreSQL 路径；本轮新增合同只供可信准备代码调用。S04 必须经过现有
  RuntimeDeclaration、授权根、pin 和资源复验再构造它。
- `service-launch.ts` 提取原 Node/Python 装配，并选择 PostgreSQL 装配；
  `withAttemptServices` 仍统一负责端口、Bubblewrap、子进程、监听归属、阶段取消、回执和清理。
  没有新增 Manager，也没有复制第二个阶段生命周期。
- `postgres-service.ts` 复用 `runtimeResourceDigest`，验证包含 bin/lib/share 的完整资源目录，
  复制阶段专属资源快照后再次比对摘要，只读挂入服务沙箱。服务拥有单独的数据目录。
- 沙箱内执行 initdb，再 exec 前台 postgres；固定监听 127.0.0.1、禁用 Unix socket。
  每阶段生成独立随机密码，使用 SCRAM；密码文件在初始化后删除，密码不写回执。
- 就绪要求 `/proc` 监听归属成立、SQL 查询返回本阶段 data_directory 和 loopback 地址，
  查询后再次检查监听归属。连接通过原 `TASK_GRAPH_SERVICES_JSON` 返回，只在阶段内使用。
- 初始化失败、运行中退出、监听归属丢失、取消均进入原失败/清理通道。
  清理继续处理其他资源；任何清理错误都会导致调用失败并保留 failureNote，
  未成功删除的资源不会标成 closed。
- 保持原 action 取消合同：调用者须响应 `context.signal`，生命周期等待 action 收尾后回收。
  没有用 Promise.race 提前释放仍在收尾的 Writer。

## 红绿与实际验证

最初用真实 PG 资源调用旧 `withAttemptServices`，在调用 action 前得到
`Service requires a unique key, consumed input, relative entry, loopback host, port and isolated data arguments`。
补齐阶段合同与装配后，同一路径能进行真实 SQL 写入和读回。

| 检查 | 结果 |
|---|---|
| `npm run test:task-graph-postgres-services` | 12 组通过，实际服务运行于 Bubblewrap |
| 旧 `tests/task-graph-services.test.ts` | Node/Python、超时/取消、owner crash 等通过 |
| `node scripts/sandbox-postgres-session.mjs run task-graph-service-execution` | 实际沙箱 exit=0，实施/检查/集成/架构/验收旧服务接线通过 |
| TypeScript 全仓 noEmit | exit=0 |
| 修改文件 ESLint、长文件守卫、diff 检查 | 全部通过 |
| 本 HANDOVER workflow preflight | exit=0，issues=[] |

12 组直接回归包含：拒绝无效摘要/重复 key/过早图接入、真实 SQL 与回执、并行隔离、
资源内容被改、启动失败、启动超时、initdb 中取消、真实端口抢占、服务退出、
服务包装进程仍活着但监听丢失、就绪后取消/调用者失败、真实文件权限造成的清理失败。
冲突测试在端口分配后由测试进程抢占端口，确认失败清理仍保留对方监听器；没有增加生产端口注入开关。

验证记录：`output/reviews/s03-phase-postgres-20261024/`。
既有服务执行的完整沙箱记录仍在
`output/sandbox-postgres-runs/2026-10-23T001728-3817574/`；该目录名称由 S02 脚本生成，
准确运行时间以 session-summary.json 的 UTC 时间为准。

## 资源来源与限制

- 复用 S02 的 zonky 14.24.0 包。原包内部有库文件软链接，不能直接通过现有摘要规则。
  测试夹具将包内链接展开为普通文件，然后用原摘要算法计算整包摘要。
- 预期摘要独立从已验证的 jar 和 txz 重新解包、确认链接均在包内、展开后得到：
  `88173c650921e15528294eccd26e6f53d5cc37eb4f8e8035bfe4700c7a98d21d`。
  测试将其固定为常量；缓存漂移时拒绝，不能把当前缓存的新摘要当成新批准。
- 本轮固定包内 bin/lib/share；仍依赖当前宿主的 Linux、libc、动态加载器和现有只读 `/usr`。
  不是完整镜像，也没有证明任意主机兼容。S04 不得把这个限定扩写为完整运行环境已固定。
- S02 的一次性数据库入口继续作为回归引导工具。S04 接运行准备时应复用 S03 的生命周期，
  再收敛 S02 的临时启动代码；不要把它复制成新的生产供应通道。
- 未进行独立 reviewer 审查；S06 仍须对固定提交与实际证据独立审查。

## S04 接续要点

1. 扩现有 RuntimeDeclaration 的数据库资源，保持未知字段拒绝和批准根约束。
2. 对资源规范化后的完整目录固定摘要并进入 pin；实施与验收消费同一个批准版本，
   每次调用 S03 都生成独立数据和连接。不要把原始软链接目录直接传入摘要函数。
3. 复用 `withAttemptServices` 的 PostgreSQL 分支，收敛两个入口的共同准备，
   保留阶段权限差异。不要放宽全局 DATABASE_URL 白名单。
4. 接线后分别验证两种真实入口；本轮函数级验证不能替代 S04 的端到端验证。
5. S05 的 environment_failed 分派和第 81 行旧断言仍未修；不得视为环境修复已全部完成。

## 提交边界

本轮修改服务合同、共享生命周期及两个窄职责装配模块、直接测试、npm 测试入口和本文。
Git 历史只追加；提交号用 `git log -1` 获取。原仓库用户修改未动。
`docs/workflow/workflow-contract.yaml` 的 automation_enabled 仍为 false。
未改图账本、旧票快照、服务部署或生产数据库；本分支尚未合入 oss-prep。

改动文件清单：

- `src/lib/task-graph/attempt-services.ts`
- `src/lib/task-graph/service-contract.ts`
- `src/lib/task-graph/service-launch.ts`（新增）
- `src/lib/task-graph/postgres-service.ts`（新增）
- `tests/task-graph-postgres-services.test.ts`（新增）
- `tests/task-graph-services.test.ts`
- `package.json`
- 本 HANDOVER 与 `output/reviews/s03-phase-postgres-20261024/` 验证记录。
