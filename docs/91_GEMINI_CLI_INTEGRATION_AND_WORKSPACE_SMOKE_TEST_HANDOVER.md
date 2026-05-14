# 91 Gemini CLI 集成与 Workspace 冒烟测试交接文档

## 日期
2026-05-10

## 目标
完成 Gemini CLI 的 `platform_local` 集成，并对全新的 Workspace UI 进行全面的自动化测试验证。

## 已完成事项

### 1. Gemini CLI 集成修复与命名统一
- **修复类型错误**：在 `src/lib/real-agents/gemini-cli-agent.ts` 中修复了 `resolveGeminiApprovalMode` 函数签名不匹配的问题，解决了构建阻塞。
- **命名规范化**：将系统各处的 `gemini` 统一重命名为 `gemini-cli`（包括数据库注册名、Agent 类型、执行器匹配逻辑等），消除了飞书端 ID 混淆的问题。
- **文件重命名**：将 `src/lib/real-agents/gemini-agent.ts` 重命名为 `src/lib/real-agents/gemini-cli-agent.ts`，以符合其作为 CLI 工具的属性。

### 2. Workspace UI 全量测试
- **E2E 自动化测试**：编写并运行了 Playwright 测试脚本（`tests/e2e/workspace-checklist.spec.ts`，运行后已清理），覆盖了以下清单：
    - **三栏布局**：确认 `/workspaces` 正常进入，且侧边栏文案已从 Rooms 切换为 Workspaces。
    - **项目投影**：确认现有房间已成功投影为 Workspace，并能正确显示 Topic 和成员信息。
    - **新建功能**：验证了新建 Workspace、设置 Topic 并自动跳转至详情页的流程。
    - **状态标签**：验证了 `idle`, `running`, `waiting`, `archived` 以及 `needs you` 等状态/注意力标签的正确显示。
    - **飞书集成**：验证了列表中的 Feishu 绑定标记以及详情页的关联状态。
    - **归档逻辑**：验证了归档工作空间的折叠显示区域。
- **兼容性验证**：确认旧的 `/rooms` 路由依然保持正常重定向和功能兼容。

### 3. 环境与稳定性
- **Next.js 缓存清理**：由于大规模文件重命名导致 `next dev` 出现模块查找错误（`Cannot find module './8948.js'`），已通过深度清理 `.next` 目录并重启服务解决。
- **服务状态**：确认 `agent-platform-dev` 服务在 systemd 下运行正常。

## 发现的问题与解决
- **Agent ID 不一致**：飞书 `/ap add` 命令中，之前由于 `platform_local` (backend) 与 `platform-local` (gatewayId) 的混淆，加上 `gemini` 与 `gemini-cli` 的命名不一，导致添加失败。现在已全部对齐。
- **端口冲突**：开发环境曾因端口 3010 被占用导致启动失败，已通过管理 systemd 服务解决。

## 后续建议
- **Gemini 稳定性观察**：在真实任务流中持续观察 `gemini-cli` 的 session 保持能力。
- **UI 微调**：根据用户反馈进一步优化 Workspace 详情面板的信息展示密度。
- **测试留存**：本次测试证明了 `workspaces` 主视角已经立住，建议后续将冒烟测试加入 CI 流程。
