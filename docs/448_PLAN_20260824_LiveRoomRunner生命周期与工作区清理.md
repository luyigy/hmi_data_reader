---
doc_type: PLAN
doc_status: completed
next_action: await_acceptance
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · LiveRoomRunner生命周期与工作区清理

## 背景

工作区遗留了一组 2026-08-19 至 2026-08-22 的未提交修改，集中在 Remote Runner 删除、
重新加入 LiveRoom 后的成员状态，以及飞书房间控制和定向路由。另有一项独立的 watcher 分支
配置修正。目标是不丢弃已有工作，将两类改动分别验证并形成原子提交。

## S01：验证、整理并提交现有改动

### 范围

1. Remote Runner 删除时同步停用对应房间成员；同一 Runner 重新注册后可恢复历史成员。
2. 路由忽略 removed、不可回复或 offline 成员；重复提及同一目标不再误判为多目标。
3. 显式 mention 优先于文档专项自动路由；房间昵称可从历史成员转移到当前成员。
4. 飞书房间创建卡每次等待目录刷新并在失败时沿用缓存；权限卡展示当前房间权限。
5. 将科学试模助手 watcher 的 Git ref 与 branch space 从旧发布分支切回 `dev`。

### 完成标准

- 受影响的 8 组聚焦测试、`npx tsc --noEmit`、长文件门禁和 `git diff --check` 通过。
- 功能修复与 watcher 配置分开提交。
- 创建并校验完成型 HANDOVER，最终工作区无未提交改动。

## 交付记录

- 功能修复：`f1c3336 fix(live-room): stabilize remote runner membership`
- watcher 配置：`7e99cb0 config(workflow): follow mold dev branch`
- HANDOVER：`docs/449_HANDOVER_20260824_LiveRoomRunner生命周期与工作区清理完成.md`
