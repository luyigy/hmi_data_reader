# 93 Gemini-CLI ID 冲突修复与上下文层级显示调研

## 日期
2026-05-14

## 1. 已完成：Gemini-CLI ID 冲突修复

### 问题现象
用户在飞书中使用 `/ap room --agents=platform_local:platform-local:gemini-cli` 尝试添加 Agent 时，系统报错 `Unknown agent ids: `（错误列表为空）。虽然 `claude-haha` 可以正常添加，但 `gemini-cli` 无法添加。

### 根因分析
1.  **冗余记录**：数据库中存在两个属于 `hello` 主机的 Gemini 相关记录：`platform-local:hello:gemini` 和 `platform-local:hello:gemini-cli`。
2.  **ID 归一化逻辑**：在 `src/lib/acpx/catalog.ts` 中，`normalizeHarnessType` 函数会将所有包含 "gemini" 的名称都归一化为 `gemini-cli`。
3.  **目录匹配冲突**：当生成 Agent 目录（Catalog）时，这两个数据库记录都生成了相同的 ID：`platform_local:platform-local:gemini-cli`。
4.  **匹配失败**：由于匹配到了多个具有相同 ID 的 Agent，导致逻辑判断失效，报错信息由于内部过滤逻辑显示为空。

### 修复操作
1.  **清理数据库**：手动删除了过时的 `platform-local:hello:gemini` 记录。
2.  **迁移成员关系**：将所有原先关联到旧 ID 的房间成员（LiveRoomMember）更新为关联到新的 `platform-local:hello:gemini-cli` ID。
3.  **验证**：修复后，Agent 目录中 `gemini-cli` 的 ID 恢复唯一性，用户可以正常添加。

---

## 2. 待处理：Agent 上下文层级显示计划

### 任务目标
让用户在飞书（Feishu）和 Web UI 中都能直观看到每个 Agent 的上下文层级（Context Level）。

### 调研方向
1.  **搜索历史文档**：查找关于 `context level` 实现的现有逻辑和交接文档。
2.  **定义层级标准**：明确 `Standard`, `Full Access`, `Isolated` 等不同层级的具体含义与前端展示方式。
3.  **UI/UX 方案**：
    *   **Web UI**：在 Workspace 的成员列表或对话框中增加层级标签。
    *   **Feishu**：在 `/ap members` 指令的输出中增加层级信息。

---

## 下一步行动
- [ ] 搜索代码库和文档以获取 `context level` 的历史背景。
- [ ] 制定具体的技术实施方案。
