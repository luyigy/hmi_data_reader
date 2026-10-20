# S01-B 验证记录

实施基线 `c1a8399`，原设计和业务代码起点见 518。此目录不代表真实飞书验收已完成。

## 红测

- `lifecycle-red.log`：从固定 A 提交加载原 Registry 实现，真实 SIGTERM 无响应进程在 participant clear 后失去登记，断言失败。没有伪造 PID。
- `legacy-protocol-red.log`：未迁移的旧 Codex app-server 入口在协议成功后、根进程 close 前返回，断言失败。该入口为了其他 Harness/Review 兼容仍保留；Manager 路径必须消除该时序空档。
- `late-cleanup-red.log`：unknown 后迟到 cleanup 失败不可观察的回归，修复后同一用例通过。

A 是等价提取，红绿缺陷集中于 B 的生命周期。红测未通过缺少新函数或模块存在性来制造失败。

## 绿测

- `lifecycle-green.log`：真实子进程与真实 Bubblewrap；协议返回不等于 close、SIGTERM 无响应、unknown 后 SIGKILL、启动失败、PID 变化拒绝信号、迟到 close、旧 participant clear、cleanup 异常和原始异常保留。期限是最大观察时间，不固定 sleep 等待成功。
- `codex-protocol-green.log`：真实 Bubblewrap 内的假 Codex 协议夹具，app-server 与 JSON 的 execute/resume 共四次，原 Session，返回前根进程已 close。
- `ticket-manager-green.log`：完整原生协议 Ticket、原 Session 补料续接、零回修；额外证明 Manager 根进程已 close 但同一 GraphWriter nonce 后代仍存活时，原 Writer 判断仍为 alive。
- `isolated-regression.log`：新 ACPX → Adapter → 原生 app-server → Manager → Bubblewrap 的完整隔离 Ticket 首次实施、补料、同 Session 续接、Git metadata 写入拒绝及节点通过。另包含 Writer nonce 后代、process lineage、continuation eligibility、interactive conversation。该批次在 service-execution 的 alive/unknown 断言失败，原失败完整保留。
- `service-baseline.log` / `service-candidate.log`：针对上述失败，在独立固定 A 工作区和 B 候选各运行同一 service-execution 原测试，均退出 0。没有改断言、Writer 代码或轮询次数。首轮原测试只打印 kind，未记录 unknown 原因，不能声称已定位这次瞬态失败的具体 /proc 路径。
- `remaining-regression.log`：review-restart、restart-ancestry、issue-execution、runtime-pinning、skill-runtime，退出 0。
- `legacy-app-server.log`：旧调用隔离、交互与失败回退约束回归，退出 0。
- `tsc.log`：完整 `npx tsc --noEmit --incremental false`，退出 0。

带数据库测试全部经 `scripts/test-task-graph-postgres.mjs` 的新建随机 schema 执行并删除。未使用生产 schema。测试模型是协议夹具，不能冒充真实 Codex + 用户飞书批准验收。

独立代码审查未发现阻断问题，指出的迟到 cleanup 结果缺口已修复并补测试。原 Writer Ownership、Task Graph 预算、claim/revision/CAS、Project Capabilities 策略规则均未修改。

日志归档仅规范行尾空白，不删除失败记录或改变测试输出内容。A 日志的两处行尾空白在 B 一并规范，Git 历史只追加。
