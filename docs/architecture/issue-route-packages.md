# 从 Issues 提审

## 准备和选择

用 Matt 的 `to-spec` 和 `to-tickets` 将定稿 Spec 与纵向 tickets 发布到项目登记的 tracker。发布前读取已有稳定标记；API 超时后先回读对账，不盲目重复建单。Gitee 的 `ap-ticket-v1` 格式见 `docs/agents/issue-tracker.md`。GitHub 使用原生子 Issue 和 blocked-by API。

将 Spec、功能原型和说明 HTML 收入 `docs/specs/<slug>/`。同目录 `spec-package.json` 登记父 Issue、扫描的 tracker 仓库及每片执行配置。例如：

```json
{
  "title": "示例路线",
  "status": "ready",
  "spec": "spec.md",
  "artifacts": ["route-review.html", "feature-prototype.html"],
  "issueRoute": {
    "parent": "gitee:owner/repo#IPARENT",
    "repositories": ["gitee:owner/reader"],
    "slices": {
      "S01": {
        "executionMode": "lean",
        "acceptance": { "mode": "automatic", "checks": ["smoke"] },
        "executions": [{
          "key": "app",
          "instructions": "本仓范围及额外约束",
          "repository": "/data1/code/app",
          "gitRef": "refs/heads/dev",
          "baseCommit": "完整的40位提交号",
          "agentSelector": "local:codex",
          "launchConfig": {
            "participant": { "gatewayId": "platform-local", "executionBackend": "platform_local", "harnessType": "codex", "role": "implementer" },
            "checks": [{ "name": "smoke", "argv": ["bash", "scripts/verify.sh"] }]
          }
        }]
      }
    }
  }
}
```

以上是格式示例，不能原样执行。实际配置须使用已登记 Agent 和真实基线，slices 必须与导入的 tickets 一一对应。模式可选 `full`、`lean`、`implement`。完整模式配置架构复核，Agent 验收另配 `reviewerId` 和 `reviewLaunchConfig.participant`。当前自动执行能力限定为已实测的 Codex / Kimi Code。

`slices` 中不写目标或 `dependsOn`。这些由 Issue 标题、正文和依赖生成。Gitee 跨仓子单必须包含在 `repositories` 扫描范围；所有 blocker 必须属于本次导入的路线，裸编号、循环和重复拒绝提审。

提交包后，在父任务飞书菜单选择「任务图 / Jobs → 提出任务路线」，再从下拉框选择 Spec。平台读取 tracker，发送 HTML/MD 附件和精简确认卡。用户展开调整模式与角色，保存后确认启动。准备动作不派发任务。

## 执行依据

确认时重新读取 Issue，冻结目标、依赖、仓库基线、角色、模式与验收条件。JSONB 回读不会改变冻结哈希。普通评论、Issue 关闭不改变目标哈希，也不能代替账本验收。

CLI 提审使用 `task-graph:propose -- --parent-task-id=... --spec-repository=... --spec-package=...`。新提审不接受手写 `--file` 依赖图。历史 `route.json` 仅为读取旧包和旧运行保留，飞书选择列表只展示 Issue 包。
