# 94 Agent 上下文层级（权限配置）显示实施计划

## 日期
2026-05-14

## 1. 背景与目标
目前 Agent Platform v2 支持多种权限层级（Context Level / Permission Profile），如 `Safe Local`, `Dev Local`, `Full Access`。这些配置决定了 Agent 是否可以执行 Shell 命令、是否需要审批以及是否有网络权限。

**现状**：用户在飞书（Feishu）或 Web UI 中无法直观看到当前每个 Agent 处于哪种权限层级，导致在执行任务时（如遇到审批拦截）感到困惑。

**目标**：在飞书和 Web UI 的成员列表中显式展示每个 Agent 的上下文层级。

---

## 2. 核心定义：上下文层级（Context Level）
上下文层级将直接映射到现有的 `AcpxPermissionConfig` 中的 `profile` 字段：

| 层级名称 (UI 展示) | 内部 Profile | 安全语义 |
| :--- | :--- | :--- |
| **Safe** | `safe_local` | 默认模式。文件写入需审批，禁用网络，仅限工作区写入。 |
| **Dev** | `dev_local` | 开发模式。文件写入需审批，开启网络。 |
| **Full** | `full_access` | 完全访问。文件写入自动审批，危险操作不拦截。 |
| **Custom** | `custom` | 自定义权限配置。 |

---

## 3. 实施计划

### Phase 1: 后端数据暴露 (API & Payload)
1.  **扩展 Payload**：在 `src/lib/live-room.ts` 的 `LiveRoomMemberPayload` 接口中增加 `contextLevel: string` 字段。
2.  **增强序列化**：
    *   在 `serializeLiveRoomMember` 中，支持传入当前房间的权限配置。
    *   在 `src/lib/workspace.ts` 的 `getWorkspaceDetail` 中，查询 `sourceTask.acpxPermissionConfig` 并填充到每个成员对象中。

### Phase 2: 飞书界面优化 (Feishu UI)
1.  **成员列表指令**：修改 `src/lib/feishu.ts` 中的 `handleMembersCommand`。
    *   **展示样式**：`- gemini-cli [m_id] | online | [Safe]`
2.  **房间状态反馈**：在执行 `/ap room` 或 `/ap status` 时，显式提示当前房间的全局权限层级。

### Phase 3: Web UI 界面优化
1.  **成员栏标签**：在 Workspace 右侧的成员列表（Members List）中，为 Agent 增加 Badge。
    *   **颜色编码**：Full (绿色), Dev (蓝色/黄色), Safe (灰色)。
2.  **详情展示**：在 Workspace 详情页或成员详情弹窗中，展示具体的权限条目（如 Sandbox 模式、网络状态等）。
3.  **交互提示**：当 Agent 处于 `Safe` 模式且需要写权限时，在对话流中增加引导说明。

---

## 4. 关键技术点
*   **权限来源**：权限目前主要定义在 `Task` 级别，通过 `sourceTask` 作用于房间内的所有成员。
*   **多 Agent 差异**：需考虑未来是否支持同一个房间内不同 Agent 拥有不同权限（目前暂按房间统一展示）。
*   **性能**：在列出工作空间总结（listWorkspaceSummaries）时，需高效加载 `acpxPermissionConfig`，避免产生大量的数据库查询（N+1 问题）。

---

## 5. 待办事项
- [ ] 在 `LiveRoomMemberPayload` 中增加字段。
- [ ] 改造 `src/lib/workspace.ts` 以包含权限数据。
- [ ] 修改 `src/lib/feishu.ts` 的 `/ap members` 输出。
- [ ] 为前端成员组件添加层级 Badge 展示。
