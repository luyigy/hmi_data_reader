# 95 Agent 上下文水位（Context Watermark）显示实施计划

## 日期
2026-05-14

## 1. 背景与目标
上下文层级（Context Level）在本项目中特指 **上下文水位（Context Watermark）**，即 Agent 当前消耗了多少上下文资源（消息数、事件数、字符数）。

**现状**：系统内部有 `checkContextWatermark` 逻辑用于在上下文过载时发出警告，但用户无法主动、实时地查看当前的资源消耗百分比。

**目标**：在飞书和 Web UI 中实时展示每个 Agent 或房间的上下文消耗水位，提醒用户及时通过 `/ap new-session` 重置上下文。

---

## 2. 水位计算标准
根据 `src/lib/acpx/runner.ts` 中的逻辑，水位由以下维度决定：

| 维度 | 软阈值 (Warn) | 硬阈值 (Hard) | 说明 |
| :--- | :--- | :--- | :--- |
| **消息数 (Messages)** | 40 条 | 60 条 | 房间内的总消息数量。 |
| **运行事件 (Events)** | 200 条 | 400 条 | 该 session 下累计的运行日志和工具调用。 |
| **字符数 (Transcript)** | 3800 字符 | 4000 字符 | 拼接后的 Prompt 长度限制。 |

**水位百分比计算公式**：
`Usage % = Max(Messages/60, Events/400, Transcript/4000) * 100%`

---

## 3. 实施计划

### Phase 1: 数据聚合与 API
1.  **数据采集器**：在 `src/lib/acpx/session.ts` 或 `src/lib/live-room.ts` 中创建一个工具函数，用于查询当前房间/Session 的水位数据。
2.  **扩展 Payload**：在 `LiveRoomMemberPayload` 中增加 `contextWatermark` 对象：
    ```typescript
    contextWatermark: {
      percentage: number; // 0-100
      status: 'normal' | 'warning' | 'critical';
      messageCount: number;
      eventCount: number;
    }
    ```

### Phase 2: 飞书端显示 (Feishu UI)
1.  **成员列表增强**：修改 `/ap members` 的输出。
    *   **展示样式**：`- gemini-cli [m_id] | online | 水位: 75% [⚠️]`
2.  **主动播报**：当水位超过 80% 时，在 Feishu 频道内发送一条系统提醒，建议用户重置。

### Phase 3: Web UI 增强
1.  **水位进度条**：在 Workspace 侧边栏的成员头像下方或名称旁边，增加一个微型进度条。
    *   **颜色变化**：< 60% (蓝色), 60-80% (黄色), > 80% (红色)。
2.  **气泡提示**：鼠标悬停在进度条上时，显示详细的指标（如：45/60 messages, 120/400 events）。
3.  **重置按钮高亮**：当水位进入 `critical` 状态时，`New Session` 按钮增加动效提醒。

---

## 4. 关键技术点
*   **计算开销**：每次刷新都统计 `TaskRunEvent` 的 count 可能会有性能压力，需考虑在 `TaskSession` 表中增加计数缓存或使用高效的聚合查询。
*   **精准度**：不同 Agent 可能会有不同的 Reset Marker（见 84 号文档设计），因此水位计算应基于每个 Agent 实际能看到的上下文切片。

---

## 5. 待办事项
- [ ] 编写通用的 `getLiveRoomContextWatermark` 查询函数。
- [ ] 更新 `LiveRoomMemberPayload` 类型定义。
- [ ] 在 `src/lib/feishu.ts` 中集成水位显示。
- [ ] 前端添加 `ContextProgressBar` 组件。
