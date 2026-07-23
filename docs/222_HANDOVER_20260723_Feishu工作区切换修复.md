---
doc_type: HANDOVER
doc_status: completed
plan: null
slice: feishu_workspace_switch_fix
plan_progress: complete
next_action: none
---

# 222_HANDOVER_20260723_Feishu工作区切换修复

## 任务类型

bugfix

## 所属主线

221 Feishu 工作区授权，阻塞当前 Phase，必须立即修。

## 为什么做

管理员已把用户授权根目录改为 `/data1/quotation`，但 fresh session 仍尝试从 `/data1/code/agent-platform-v2` 启动，并报 `bwrap: Can't chdir`。

根因是历史 P2P `FeishuConversationBinding.senderOpenId` 为空；`/ap user workspace` 原先只按 `senderOpenId` 查绑定，因此只更新了 `FeishuUserAccess.workspaceRoot`，没有同步绑定房间及来源 Task 的 `workingDirectory`。

## 修改内容

- `src/lib/feishu-access-approval.ts` 的 `handleFeishuUserManagementCommand` 在处理 `workspace` 时，同时用用户表已有的 `chatId + p2p` 兼容匹配历史绑定。
- 已对当前用户重放工作区设置并修正 PostgreSQL：用户授权根、Live Room cwd、来源 Task cwd 均为 `/data1/quotation`。
- 已中断旧运行进程并确认相关运行服务为 `active`。

## 提交

- 分支：`oss-prep`
- 实现提交：`0d018e9 feat(feishu): sandbox authorized workspaces`

## 验证结果

- 修改前 GitNexus impact：`handleFeishuUserManagementCommand` 为 LOW，1 个直接测试调用，0 条受影响执行流程。
- TypeScript 检查通过，Feishu 用户管理测试（含历史 binding 的 `senderOpenId` 为空、仅靠 `chatId` 找回）通过。
- fresh session 实际 cwd 已验证为 `/data1/quotation`。
- 未再出现旧目录的 `bwrap Can't chdir`。
- `git diff --check -- src/lib/feishu-access-approval.ts` 通过。
- GitNexus `detect_changes` 因服务端 `Transport closed` 未能完成，改用精确暂存清单与 cached diff 审核。

## 对主线的影响

存量用户切换授权根目录的阻塞已解除，221 计划可继续验收。业务状态与代码兼容修复均已完成并提交。
