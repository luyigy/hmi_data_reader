---
doc_type: HANDOVER
doc_status: blocked
next_action: blocked
plan: docs/481_PLAN_20261001_LiveRoom原生模式Antigravity优先试点.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Live Room 通用原生包装层 S01 实测

## 结论与授权

用户在当前任务房间 2026-10-01 08:46 明确批准 481 PLAN，并指定在当前 session 完成 S01。本轮已完成隔离实测、探针和证据交付；**S01 准入未通过，阻塞 S02，不派发后续实现**。没有修改生产链路、能力声明、全局默认设置、watcher 或 cursor。

不能把阻塞解释成“Antigravity 完全没有原生事件”：TUI 的工作区 lifecycle hooks 确实可用，正常轮次有 Stop 和结构化 transcript；但两次 TUI 实验中的 Esc 取消没有 Stop，权限弹窗取消也没有 Stop。仅靠现有已验证接口，尚不能可靠区分取消后的空闲、未完成和等待，也不能保证一轮一次结算。不得通过屏幕文字或固定等待时长补齐。

## 交付入口与复跑

- `scripts/probes/native-session-probe.py`：Python 标准库探针，CLI 参数/输入/事件分别在 agy/pi 分支；不是生产适配器。
- `docs/evidence/481-s01-native-probe.jsonl`：23 组脱敏观察记录，每行一个 case，含命令、输入时刻、退出状态、选取的事件、原始报告 SHA-256。编号为临时目录后缀，不是会话 ID。长回复仅保留 preview，思考内容、邮箱、账户路径和会话 UUID 不入库。
- 原始日志在本机 `/tmp/ap-native-<evidence_id>/`，目录权限由 mkdtemp 限定；日志可能含账户信息，不直接发送。临时文件可能被系统清理，长期结论以入库证据为准。
- 本机 agy **1.2.14**，pi **0.83.0**。模型来自当次 `agy models` / `pi --list-models` 查询，样例型号仅用于复跑，不得成为产品默认常量。

```bash
python3 scripts/probes/native-session-probe.py agy turns --model gemini-3.8-flash-low --seconds 60
python3 scripts/probes/native-session-probe.py pi turns --model zai/glm-4.7 --seconds 60
python3 scripts/probes/native-session-probe.py agy queue --model gemini-3.8-flash-low --seconds 70
python3 scripts/probes/native-session-probe.py pi queue --model zai/glm-4.7 --seconds 70
python3 scripts/probes/native-session-probe.py agy hooks --model gemini-3.8-flash-low --seconds 60
python3 scripts/probes/native-session-probe.py agy hooks-permission --model gemini-3.8-flash-low --seconds 40
python3 scripts/probes/native-session-probe.py agy no-auth --seconds 20
```

其余 case：`resume`、`tools`、`interrupt`、`invalid`、`control`、`slash`、`tui`、`hybrid`、`tui-json`、`permission`。实际完整参数保存在对应证据行；恢复用 `--resume-from <本探针生成的report.json>`，只使用本轮新建的隔离会话，不使用 `--continue` 或用户现有 ID。模型与强度分开传 `--model` / `--effort`。

每次运行新建临时工作区、只读样例文件和独立会话；恢复实验复用自身会话。默认总观察超时 90 秒，可设 1–300 秒，finally 清理自身新建进程组（TERM、最多等待 2 秒、KILL、最多等待 2 秒），不使用全局 pkill。总时长最多另加约 4 秒清理时间。保留临时证据及 CLI 自建项目/会话元数据，没有删除其他会话。

`turns` 具有真实 CLI 断言：退出 0、两次完成、成功状态、上下文关键词 COBALT 保留；agy 还要求同一 conversation_id。其他 case 是观察探针，脚本退出 0 仅表示采样完成，CLI 退出状态及结果必须读 report，不能当作全部能力通过。TUI 按时刻发送测试按键，只用于实验，绝不是生产状态判断。

## Antigravity 矩阵

| 检查 | 实测结果 | 判定 / 证据 ID |
| --- | --- | --- |
| stream-json 启动、两轮 | 单 PID、单 conversation_id，两次 SUCCESS result，num_turns=1/2，均回答 COBALT；关闭 stdin 后 exit 0 | 通过，yri78uqd；最终断言重跑 l8z7p0f9 14.877 秒通过 |
| 恢复与切换启动设置 | 自有会话恢复，low 改 medium，init.model 回读 gemini-3.8-flash-medium，记住 COBALT，num_turns=3，exit 0 | 恢复与型号回读通过，hvuzwl9a；没有独立 effort 字段，不能扩大为所有模型强度已确认 |
| 不兼容设置 | medium 型号配 low 强度：ERROR，明确 conflicts with --effort=low，exit 1 | 校验通过，f0gn62fa；随后用匹配设置恢复成功，不隐藏失败实验 |
| 运行中追加/排队 | 在 ACTIVE 后写第二条；第一条完成后才答 QUEUED_SECOND；两个 result、exit 0 | 排队通过，r8bk3y4b；没有 steer 接收回执，不宣称 steer |
| 同名工具辨别 | view_file 两次，各有 ACTIVE/DONE，step_index 分别 2/4，一个最终 result | 通过，ooqrxhqe；调用键应含会话+step_index，不按名称去重 |
| 流式停止 | 首次 ACTIVE 后对自身进程组发 TERM，收到 ERROR/interrupted 与部分回复，exit 1 | 进程停止通过，o80_sp37；不是常驻会话软取消 |
| 控制请求 / 菜单 | control_request 与 /model 分别输出 ERROR 并 exit 2 | 此 stream 接口不支持，lhjbuv2n / 39ez79sy |
| 非法 JSON | ERROR result，exit 1 | 通过，ab4sbel7 |
| TUI 本体 | PTY 中回复 NATIVE_READY，/model 与 /effort 可打开并 Esc 返回；界面显示 low，/exit 后 exit 0 | 启动/菜单可见通过，1sn8yr3a；没有选择菜单项，不修改全局默认值 |
| TUI 与 JSON 合并 | --prompt-interactive 加 input-format 被明确拒绝 exit 2；仅加 output-format 仍是 TUI，未见 JSON result | 组合不成立，axm7ubo0 / smlvn36q；不能另起 JSON 进程冒充同一进程 |
| TUI 原生 hooks | 本项目 .agents/hooks.json 生效；正常两轮有 PreInvocation/PostInvocation/Stop；Stop 包含 fullyIdle=true、terminationReason=NO_TOOL_CALL | 正常结束事件部分通过，g_wm3s76；三次正常结束的 executionNum 都是 0，不能充当唯一轮号 |
| TUI Esc 与续聊 | 第三轮生成中 36 秒发 Esc，42 秒再输入 AFTER_CANCEL，第四轮可成功；第三轮没有 PostInvocation/Stop；另一次实验同样缺 Stop | **阻塞**，g_wm3s76，复现原始记录 _ybb6ctw；同 PID 仍可用不等于取消结算已可靠 |
| 最终回复读取 | hook 给出 transcript_full.jsonl（与文档示例文件名不同）；结构化 USER_INPUT/PLANNER_RESPONSE 有 step_index，正常回复可对应 | 部分通过，g_wm3s76；只在实验结束后核对，Stop 触发时落盘顺序、异常轮终态仍未验证 |
| 权限可见 | 项目 PreToolUse force_ask 对 printf 强制询问；TUI 显示 Requesting permission / Run this command；Esc 取消，无命令执行确认，无 Stop | 弹窗可见通过，hus1xv_c；权限取消机器终态缺口未解决 |
| headless 权限拒绝 | 默认 request-review 下 printf 未执行，result 却为 SUCCESS、response 空、denied_actions 含 RunCommand，exit 0 | 必须独立处理 denied_actions，n21weih5；不能把 SUCCESS 等于请求已完成 |
| 缺少登录 | Bubblewrap 子命名空间只隐藏 .gemini；stderr authentication required，ERROR result，exit 1 | 缺登录可见通过，mmxbmrl1；未登出用户；过期 token 的刷新失败分支未验证 |

恢复实验的 duration_seconds 是会话累计值，不能当成本轮耗时。TUI 第三轮还观察到服务端内容过滤 ERROR_MESSAGE 后继续生成；这一实测异常保留在 transcript 类型摘要中，不能按第一个 ERROR_MESSAGE 就结算最终失败。

## 第二种 harness：pi 矩阵

| 检查 | 实测结果 | 判定 / 证据 ID |
| --- | --- | --- |
| RPC 启动、两轮 | 同一进程，prompt 接收回执与 agent_end 分离，两轮回答 COBALT，exit 0 | 通过，wjuidtzt；最终断言重跑 v7q10qp2 4.564 秒通过 |
| 会话恢复 | --session 指定自有 jsonl，get_state 返回原 sessionId；可回答 COBALT | 通过，zj59lcc_ |
| 设置回读 | get_state.model.id=glm-4.7、thinkingLevel=low；返回消息 responseModel=glm-5.3-flash，compat.supportsReasoningEffort=false | CLI 选择值可读；上游实际型号与强度效果不能据此确证，不宣称已生效 |
| 运行中 followUp | message_update 后发 streamingBehavior=followUp，接收回执成功，第二条最终回答 QUEUED_SECOND | 通过，ie_vophy；**两个 turn_end，但整批只有一个 agent_end** |
| abort | message_update 后发送 abort，收到 success 回执、assistant.stopReason=aborted、agent_end，get_state.isStreaming=false | 通过，yi1enf87；未在这条实验中进一步测试取消后继续输入 |
| 同名工具 | 两个 read，各有不同 toolCallId，开始和结束配对 | 通过，vwnmxfp5；模型将两次调用放在同一工具批次，不宣称验证了强制串行 |
| 不支持的 RPC 命令 | not_a_command 返回 success=false/Unknown command，进程继续等待；探针 5 秒超时后停止 | 错误可见，jki33n9y，CLI exit 143 来自探针清理，不是原生自动退出 |
| TUI/菜单、TUI 与 RPC 同进程 | 本轮未运行 pi TUI | 未验证，不宣称第二种原生终端已支持 |
| 细分强度、运行中设置、权限/登录失效 | 仅读取本轮启动设置，没有 set_model/set_thinking_level 写默认配置 | 未验证，保持能力缺省；本轮不实现完整第二适配器 |

首个 pi queue 探针误等两个 agent_end，实际已完成两条输入却等到 90 秒超时（w91uvyhu）。已依据真实语义修正观察停止条件并重跑成功，保留原失败证据。**不能把 agent_end 直接规范化为一个用户请求完成**：有工具时一个用户请求也可包含多个 turn_end（vwnmxfp5）。适配器必须关联输入、assistant 终态、待处理队列及批次终态。

## 通用边界与最小后续范围

1. 共享包装层只拥有成员/会话/generation、进程、输入认领、权限、连接与一次结算；不得解析 agy 的 step_index 或 pi 的 agent_end。当前实验不需要改共享协议，所以未运行 GitNexus；后续变更共享协议仍需按 AGENTS 分析。
2. agy adapter 区分 stream-json 和 TUI+hooks；pi adapter 区分 RPC 批次与用户轮次。两种协议的“完成”不能只换一个事件名。恢复 ID/文件、模型标识、强度范围、拒绝权限结果全部由 adapter 解释。
3. 现有 `getHarnessCapabilities(..., platform_local)` 运行检查：agy 与 pi 的 supportsLiveSessionControl 都为 false；未知 harness 五项能力全 false。pi 的 supportsQueuedUserMessages=true 是既有平台队列能力，不等于原生终端可用。本轮不改任何能力标志。
4. 原生 hooks 是可继续验证的候选：先补齐 Esc/权限取消的结构化终态、稳定用户轮号和 transcript 落盘时序；再验证外部输入不会在菜单或权限弹窗中误提交，恢复和设置回读也必须保留同一所有权。
5. 若这些缺口无法解决，可另行确认一个**仅 stream-json 消息包装层**的限定试点，暂不提供原生终端菜单和同进程软中断。此方案不等于已批准 PLAN 的完整目标，本轮没有擅自换范围，也没有换 pi 冒充 Antigravity 试点。

官方协议依据（实际通过/失败以本机实测为准）：[Headless](https://antigravity.google/docs/cli/headless/)、[Hooks](https://antigravity.google/docs/hooks/)、[Remote Control](https://antigravity.google/docs/remote-control?tab=cli)。Remote Control 是原生双端通道的另一个候选，但未验证供平台使用的控制/事件接口，本轮未开启反向隧道或 daemon。pi 参考本机 0.83.0 安装包的 docs/rpc.md，未凭文档把未测能力标通过。

## 验证与收口

- 开工长文件检查通过，没有 >=1000 行文件；新增探针 318 行，不增长既有长文件。
- Python AST 语法检查通过；最终脚本两个真实 turns 断言通过；上述 23 组证据已脱敏入库。
- 29 个本轮探针进程组逐一检查已不存在；未操作用户运行中的 CLI 会话。新版本探针校验 `.gemini/config/config.json`、`.gemini/antigravity-cli/settings.json` 和 `.pi/agent/settings.json` 前后摘要一致；较早实验只校验前后两个配置路径，不能以此宣称全目录无变化。
- 工作流骨架由 workflow:new 生成，正文改为 blocked / blocked；首次 preflight 指出非可执行动作不得含自动化 Prompt（PROMPT_FORBIDDEN），已按校验器移除标记及内容，避免派发 S02；修复后 preflight、最终长文件及 diff 检查通过。
- 未修改 PLAN（授权来自当前对话，无需重走审批），没有生产代码/依赖改动。已有 feishu-help、对应测试、inbox ISSUE、gitnexus-wiki 和 output 工作区改动全部留原样，不夹带提交。
