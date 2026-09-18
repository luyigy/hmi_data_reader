---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: hotfix
plan_progress: complete
---

# HANDOVER · Windows SSH 与 Pi 提示词修复

## 完成内容与根因

- 中文 Windows 的 cmd.exe 缺失 bash 时输出本地化或乱码错误，原来的英文匹配漏掉 PowerShell 回退。现在识别行首被引号包围的 bash/printf 命令；认证失败、连接拒绝及 bash 内部找不到 pi 仍不回退。
- PowerShell 将包含双引号与 `->` 的 Pi 提示词拆成参数，触发 `Unknown option: ->`。首次执行与继续会话均改为由 Pi 直接读取 SSH stdin，不再经过 PowerShell 的原生命令参数转换。
- 飞书后台是常驻进程，旧进程不会自动加载仓库修改。用户手动执行 `systemctl --user restart agent-platform-feishu.service` 后已确认恢复。

## 验证

- `tests/remote-ssh-windows-fallback.test.ts` 本次通过，覆盖中英文/乱码回退、非回退错误、复杂提示词及 continue。
- 上次会话记录的真实 Windows 验证：`WINDOWS_PROMPT_OK`、`WINDOWS_RESUME_OK`；本次以用户重启后确认恢复作为线上验收。
- `npm run check:long-files`：无文件达到 1000 行。
- `tests/remote-ssh-pi-progress.test.ts`：修复伪 SSH 未读取 stdin 就退出的 EPIPE 竞态后通过。

## 修改边界与后续

生产文件：`src/lib/remote-harness/ssh-executor.ts`；新增回归：`tests/remote-ssh-windows-fallback.test.ts`；测试替身修正：`tests/remote-ssh-pi-progress.test.ts`。工作区其他会话的飞书新会话/建群改动不包含在此交付中。

另一个问题属于 Remote Runner：机台数据采集群的 desktop-78hk9dd-b2ea3685 原始 Pi JSON 被直接显示为思考分析，正在独立排查，不属于 SSH 修复。
本交接为独立 hotfix，无关联 PLAN；骨架由 workflow:new 生成后按终态交接填写，不启动下一 Session。
