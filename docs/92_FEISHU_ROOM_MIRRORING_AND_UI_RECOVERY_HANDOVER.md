# 92 Feishu 房间镜像与 UI 恢复交接文档

## 日期
2026-05-14

## 目标
解决 Feishu 房间 `deepwiki` 在 Web 端无法识别的问题，并修复 Next.js 开发环境下的样式丢失故障。

## 已完成事项

### 1. Feishu 房间镜像修复
- **问题背景**：用户反馈 Feishu 群聊 `oc_803a93df5272969d87b4760a3fc0fa5d` (deepwiki) 未能镜像到 Web UI。
- **调查发现**：
    - 数据库中已存在绑定关系，但该房间被自动命名为 `Feishu Group c0fa5d`（取自 chatId 末尾）。
    - 由于名称不匹配，用户在 Workspace 列表中未能直观识别出该房间。
- **修复方案**：
    - 手动将数据库中 `LiveRoom` 表的 `title` 从 `Feishu Group c0fa5d` 更新为 `deepwiki`。
    - 验证后，用户确认在 Web 端已能正确看到镜像房间。

### 2. Web UI 样式恢复
- **问题现象**：网页样式（CSS）突然丢失，控制台出现大量 500 错误。
- **根因分析**：
    - 查看 `agent-platform-dev` 服务日志发现 `MODULE_NOT_FOUND` 错误，指向 `.next` 编译缓存损坏。
- **操作步骤**：
    - 执行 `rm -rf .next` 清除 Next.js 缓存。
    - 重启 `agent-platform-dev.service` 触发重新编译。
- **结果**：样式已成功恢复，页面功能正常。

### 3. 环境与服务状态
- **Next.js**：在 3010 端口运行正常。
- **Feishu Runtime**：虽然在日志中观察到长连接（Persistent Connection）间歇性报 `system busy` 错误，但基础的消息处理和房间同步逻辑依然保持可用。

## 后续建议
- **房间重命名机制**：目前 Feishu 房间默认标题生成规则较为机械，建议后续增加自动同步 Feishu 群名称的逻辑，或在 UI 上提供明显的重命名入口。
- **缓存监控**：Next.js 开发模式下的缓存损坏偶尔发生，如再次出现样式丢失，可优先考虑清理 `.next` 目录。
