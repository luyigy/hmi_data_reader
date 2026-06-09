# 107_HANDOVER_20260609_Codex路径修复

## 任务类型
bugfix / docs

## 所属主线
临时插队

## 为什么做
Feishu 新会话启动 Codex 时返回 `gpt-5.5` 需要更新 Codex CLI 的错误，导致 Feishu 侧 Codex 无法正常回复。排查后发现问题集中在本机 Codex CLI 安装、用户级模型配置、以及 systemd user service 的 PATH 解析上，阻塞 Feishu 侧 Codex 使用。

## 修改内容
- 创建 Codex skill：`/home/hello/.codex/skills/handover-file-naming/SKILL.md`，记录团队 flat docs 命名与 handover 工作流。
- 更新全局 npm Codex：`npm install -g @openai/codex@latest`，当前 npm 官方与镜像 registry 均返回 `@openai/codex@0.138.0`。
- 移除 NVM 下重复的旧 Codex：`/home/hello/.nvm/versions/node/v22.22.1/bin/codex`，避免 Feishu service 或交互 shell 命中旧路径。
- 确认当前唯一 Codex CLI 路径为 `/home/hello/.local/bin/codex`，版本为 `codex-cli 0.138.0`。
- 修正用户 Codex 配置：`/home/hello/.codex/config.toml` 当前恢复为 `model = "gpt-5.5"`。
- 固定 repo user service 的 PATH：
  - `scripts/run-feishu-runtime.sh` 增加 `export PATH="/home/hello/.local/bin:${PATH}"`。
  - `scripts/run-agent-platform-dev.sh` 增加 `export PATH="/home/hello/.local/bin:${PATH}"`。
- 按 `docs/SYSTEMD_USER_COMMANDS.md` 重启正确的 user services：
  - `agent-platform-dev.service`
  - `agent-platform-feishu.service`

## 验证结果
- `which -a codex` 只返回 `/home/hello/.local/bin/codex`。
- `codex --version` 返回 `codex-cli 0.138.0`。
- 直接测试 `gpt-5.5` 成功：
  - `/home/hello/.local/bin/codex exec --json --skip-git-repo-check -m gpt-5.5 -`
  - `/home/hello/.local/bin/codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -m gpt-5.5 -`
- `agent-platform-dev.service` 和 `agent-platform-feishu.service` 均为 `active (running)`。
- Feishu runtime 日志出现 `[ws] ws client ready`。
- 用户在 Feishu 验证原始失败已修复。

## 对主线的影响
阻塞 Feishu Codex 会话的问题已解除。此次修复没有改变 live room 核心业务逻辑，但收敛了服务运行环境，使 Feishu runtime 明确使用 `/home/hello/.local/bin/codex`，减少后续 CLI 版本和 PATH 问题。

## 下一步建议
- 保留 `scripts/run-feishu-runtime.sh` 和 `scripts/run-agent-platform-dev.sh` 中的 PATH pin，避免 systemd user service 受 NVM shell 初始化影响。
- 后续若 npm 发布高于 `0.138.0` 的 `@openai/codex`，再执行 `npm install -g @openai/codex@latest` 并复测 Feishu `gpt-5.5` 会话。
- 若继续出现 NVM 与 npm prefix 警告，可单独整理 `~/.npmrc` 与 NVM 初始化配置；该警告当前不阻塞 Feishu runtime。
