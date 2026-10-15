# 飞书用户管理卡（User Admin Card）使用与设计说明

本文档说明 Agent Platform 在飞书管理员私聊中提供的可视化用户管理卡（User Admin Card）功能、交互流程与实现架构。配合面向终端用户的入门指南 [agent-platform-quickstart.html](agent-platform-quickstart.html) 使用。

---

## 1. 功能概述

管理员过去只能通过一系列文本命令（如 `/ap user approve <open_id> --workspace-root=...`）逐个配置用户权限与工作区。

新增的交互式用户管理卡（`/ap users`）让管理员可以在飞书私聊中直接以卡片形式：
- **查看与筛选用户**：按准入状态（`pending`、`approved`、`denied`、`revoked`、`blocked`）分页/分类查看。
- **解析真实姓名**：自动调用飞书通讯录 API 获取用户真实姓名，并支持在线修改用户昵称。
- **分配工作区**：在卡片表单中直接输入/修改用户的工作区绝对路径，若目录不存在会自动安全创建（`mkdir -p`）。
- **一键权限变更**：卡片上提供批准、拒绝、撤销、封禁、解封按钮，操作后即时更新卡片状态并给对应用户发送通知。

---

## 2. 管理员操作指南

### 2.1 打开卡片

在**飞书管理员与机器人的私聊**中发送：

```text
/ap users
```

或带状态筛选：
```text
/ap users --status=pending
/ap users --status=approved
```

> **权限检查**：非管理员用户发送该命令会被拒绝，并提示仅管理员可在私聊中打开管理卡。

### 2.2 卡片交互项

1. **状态筛选标签**：卡片顶部提供各状态标签，点击即可切换查看对应状态的用户列表。
2. **用户基本信息**：
   - 显示 Open ID、用户昵称及飞书通讯录解析出的姓名。
   - 点击“修改昵称”提交新昵称，平台数据库即时更新。
3. **工作区目录设置**：
   - 卡片中显示当前绑定的绝对路径。
   - 在表单输入框中填入新路径并提交：平台会校验路径是否合法，若目录在宿主机上尚不存在，会自动执行递归创建并赋予当前执行用户读写权限。
4. **状态动作按钮**：
   - `pending` 用户：提供 **批准（Approve）** 与 **拒绝（Deny）**。
   - `approved` 用户：提供 **撤销（Revoke）** 与 **封禁（Block）**。
   - `revoked` / `denied` 用户：提供 **重新批准** 或 **封禁**。
   - `blocked` 用户：提供 **解封（Unblock）**。

---

## 3. 架构与核心实现

| 模块 | 路径 | 核心职责 |
| --- | --- | --- |
| **卡片构建** | `src/lib/feishu-user-admin-card.ts` | 构造飞书交互卡片 JSON，包含表单输入框、动作按钮与状态回显。 |
| **管理服务** | `src/lib/feishu-user-admin.ts` | 处理用户查询、飞书 API 姓名反查、昵称修改、状态流转及通知发送。 |
| **工作区管理** | `src/lib/feishu-workspace.ts` | 校验工作区路径、在主机上自动创建缺失目录。 |
| **卡片回调路由** | `src/lib/feishu-interaction-card-action.ts` | 监听并分发 `user_admin_*` 交互卡片动作至对应处理函数。 |
| **命令入口与帮助** | `src/lib/feishu-help.ts`、`src/lib/feishu.ts` | 注册 `/ap users` 命令，输出帮助与操作回显。 |

---

## 4. 自动化测试验证

相关功能均包含自动化单测，涵盖卡片渲染、表单回调、状态机流转与目录创建：

```bash
# 运行用户管理卡核心测试
TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
  node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/feishu-user-admin.test.ts

# 运行通讯录姓名查询与降级测试
TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
  node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/feishu-user-name-lookup.test.ts

# 运行工作区创建与验证测试
TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
  node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/feishu-workspace.test.ts
```
