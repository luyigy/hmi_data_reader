# M6_FANUC 固定技能包真实业务验证

状态：记录已发生的真实实施与验证；未独立验收通过。后续用户要求暂停改造、先讨论架构；本文不表示任务当前仍在执行。

用户明确要求直接用 M6 验证后，本轮仅启用已列明的固定只读工程技能包，沿原平台入口接回原任务。不再另开原生模型隔离任务，不代替业务 Agent 修改业务代码。

## 真实授权与原入口接续

2026-10-22 23:15:11 CST，原项目能力配置保留全部五个只读目录、原 browser 声明、资料源及主体，只增加一个目录及其 skills 声明：

`/home/hello/.agent-platform/runtime-resources/pstack-engineering-635440398b945f04dd11372c`

固定包 SHA256 为 `635440398b945f04dd11372c795a67bd862bb3030e91fb50c89c5bf10b458000`。新项目 policyHash 为 `bd718a202061ba7771244e8ecd6cbd3c0f16fa21736e0ab23eb309b68a75d674`。

启用前发现上轮离线预览脚本的 Set 展开在当前转译设置下产生空列表。错误预览从未写入生产；改为 Array.from，并断言所有原目录保留、只增加一个目录后，才应用上述配置。此前 538 中的预览 hash `47e923...` 作废，不能用于执行。

通过 `migrateLegacyProjectScope` 的显式 prepareRuntimeUpgrade 模式，仅追加 M6 的 scope 批准。Coordinator 随后消费资源条件变化，完成原 admitNode、claimNode、claimExecution。没有直接改 ready/claimed，没有重置预算，没有发恢复控制命令，没有恢复其他暂停节点，也没有重启服务。

| 项目 | 实际证据 |
| --- | --- |
| Run | cmvdmf87w043f9xhgf9yvua6p |
| Execution | cmvdmf87z04439xhgbpz1iy56 |
| 新实施 TaskRun | cmvjonpv3088214kk0fzhbryt |
| TaskSession | cmvjjbkl44v0nkf9dl31mq59x，沿用原值 |
| 原生 Codex Session | 01a163a5-f26b-7741-87d3-94a4464f55e3，实际运行元数据确认 sameSessionConfirmed=true |
| 新 TaskRun 创建 | 2026-10-22 23:15:37 CST |
| Worktree | 原任务专属 Worktree，未更换 |
| 历史 runtime pin | 启用前 105 份，逐项比对 payload 未改写 |
| 新 claim | 279617a2-6bee-4c5a-8f18-6d2f3aa51dac |
| 四类已用预算 | 均为 0，未重置 |
| 进入新 claim 的无进展计数 | 原值 3 保留 |

## 已观察到的业务成果

原 Session 的真实工具调用已读取固定包内 poteto-mode、how、architect、principle-model-the-domain，并继续读取 arena、项目校验入口及本仓源码。首批读取工具实际返回 exit 0；完整包预检回执也保留在新 runtime pin 中。部分工具输出被长度上限截断，不能把截断文本中找不到标题误报为文件不存在。

23:19，原 Session 修改 `backend/app/hmi_mapping/package_onboarding.py`，修复 temperature 目标校验只允许小写字符、拒绝冻结物理温区身份含大写字母的问题。此改动由业务 Agent 的原生工具执行，平台父任务未代写。

随后实际执行本票命令：

```text
DATABASE_URL=sqlite:// PYTHONDONTWRITEBYTECODE=1 /data1/code/mold-data-webpage-tool/backend/.venv/bin/python -m pytest -q backend/tests/test_hmi_protocol_library_m6_fanuc.py
```

23:19:50 原生工具结果为 `5 passed, 1 warning in 15.86s`，exit 0。警告是既有 Starlette/httpx 弃用提示。之后 Agent 继续修改本票测试文件，补齐后续行为证据。

以上证明原技能阻塞已越过，并产生实际代码与测试成果。五项专项测试不代表所有新页链路、双视口浏览器和独立验收通过；这些结论只按后续真实结果追加。

运行取证位于 `output/reviews/m6-live-skill-verification-20261022/`，包含授权、启用前快照、最新账本/原生会话、原生读取与测试结果。生产配置备份不进入 Git。


## 后续真实结果与未完成项

同一原生 Session 随后扩展测试并修复失败，最终本票 `ticket-behavior-6.log` 记录 `12 passed, 1 warning in 86.91s`。附近回归 `nearby-regression.log` 记录 `22 passed, 1 warning, 1 error in 8.60s`，错误位于 `backend/tests/m04t_reader_fixture.py:16` 的 fixture 断言，不能报告全部回归通过。

Agent 还增加本票浏览器驱动，产生 1440 和 390 两种视口的原页、图像重开、手工重开、分组冲突和分组重开截图，以及相应读回 JSON。这些成果不能替代尚缺的独立图像语义、启用状态裁定或全部联合验收。

平台保存业务候选 `9b7ef77cecae5c9d37e105af2c75e972d9ac42de`。实施者返回 `status=blocked`，但没有 `blockerKind`；当前实现将其归为 `invalid_result`，反复进入 `collect_result`，独立验收没有因此完成。留存快照 `latest.json` 的观察时间为 `2026-10-22T15:32:49.059Z`，当时为 `collect_result`、`formatAttempts=4`；这是历史取证，不是本文提交时的实时状态。

原始报告及日志保存在本机任务验证目录 `task-validation/e6690cc2bc8130585c3c72cc/855c240c994099d5cfd197ad/`；生产配置备份、完整任务输入和原生会话不加入 Git。

## 当前讨论方向与源码边界

用户要求 Matt 与 pstack 贯穿工程执行：只配置实施者时由实施者自查自纠；配置测试者时由测试者负责验证并反馈缺陷。平台承担调度、记录、受控集成与运行安全，不额外制定第二套业务门槛。该方向尚未实施，不能将现有“仅实施、未验收”标签等同于自查完成，也不能把一轮结束、出现 diff 或格式错误默认为交付通过。

- [当前方向：Agent 负责工程判断的交互导览](show-me-agent-owned-quality-20261023.html) 对比现状、两种角色配置和源码堵塞点。
- [此前验收断链讨论稿](show-me-acceptance-criteria-chain-20261023.html) 保留历史分析，其中新增平台业务门禁等建议已被后续方向替代，不作为施工定稿。

暂停前在 `/tmp/ap-live-result-contract` 中的结果交接修复与回归测试草稿未提交、未合入，也未部署。当前讨论文档不授权恢复 M6、修改生产账本或新增资源范围。
