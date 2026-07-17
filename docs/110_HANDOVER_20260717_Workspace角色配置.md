# 110_HANDOVER_20260717_Workspace角色配置

## 任务类型
feature

## 所属主线
Workspace 多 Agent 协作

## 为什么做
Workspace 已支持选择 Agent 和指定代码目录，但成员没有独立职责，无法稳定表达 planner、implementer、reviewer、tester 等软件团队分工。现有 `roleLabel` 承担远程 Agent 路由信息，不能复用为职责字段。

## 修改内容
- 已提交 Workspace 创建时指定工作目录：`fb7f354 feat: set workspace directory on creation`。
- `LiveRoomMember` 新增独立 `role` 字段，保留 `roleLabel` 的远程路由职责。
- 创建 Workspace、后续添加成员时均可选择角色。
- Workspace 成员列表可修改角色，修改后立即同步关联 ACPX Task。
- ACPX participant 使用成员角色，不再使用成员显示名称。

## 实施计划
1. [x] 为 `LiveRoomMember` 增加独立 `role` 字段和数据库迁移。
2. [x] 创建 Workspace 时允许为每个已选 Agent 指定角色。
3. [x] 后续添加成员时允许指定角色，并在成员列表中允许修改。
4. [x] 同步 ACPX participant 时使用成员角色，不再使用成员显示名称。
5. [x] 执行 Prisma、TypeScript、目标 ESLint 检查。

## 验证结果
- 工作目录功能：`npx tsc --noEmit` 与目标文件 ESLint 通过。
- `npx prisma migrate deploy`：迁移成功应用到本地开发数据库。
- `npx tsc --noEmit`：通过。
- 目标文件 `npx eslint ...`：通过。
- `git diff --check`：通过。
- 全仓库 `npm run lint` 仍有本次修改前已存在的 lint 错误。

## 对主线的影响
补齐 Workspace 作为软件开发团队编排入口所需的角色语义。

## 下一步建议
在页面创建 Workspace，分别选择 planner、implementer、reviewer、tester，执行一次真实串行协作烟测。
