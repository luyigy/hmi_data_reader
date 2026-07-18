# 205_HANDOVER_20260718_Antigravity认证代理修复

## 任务类型
bugfix / test / docs

## 所属主线
支线任务：本地 harness 扩展；阻塞 Antigravity CLI 从 Feishu Live Room 正常执行，必须立即修。

## 为什么做
Antigravity CLI 在用户终端中已经登录且可正常启动，但由 Agent Platform spawn 时反复向 stderr 输出 `Authentication required` 和 Google OAuth 登录 URL。用户已经完成授权，不应在每次任务执行时重新交互登录。

平台调用参数为 `agy -p <prompt> --sandbox`，Full Access 则使用 `--dangerously-skip-permissions`。相同的 print-mode smoke test在交互终端可以成功，因此问题不在 `-p` 或权限参数本身。

排查 Antigravity CLI 日志后确认：

- OAuth access token 按正常机制定期过期，CLI 应使用本地 refresh token 静默续期。
- 失败的 platform spawn 直接连接 Google OAuth/UserInfo 地址并超时，静默认证失败后才退回交互 OAuth，因此用户看到登录 URL。
- 成功的终端命令使用 shell 中的代理变量，可以完成静默认证。
- `npm run feishu:runtime` 为避免 Feishu runtime 本身走代理，会移除通用代理变量，并把子 CLI 需要的值保存在现有的 `FEISHU_RUNTIME_CODEX_HTTP_PROXY`、`FEISHU_RUNTIME_CODEX_HTTPS_PROXY`、`FEISHU_RUNTIME_CODEX_ALL_PROXY` 和 `FEISHU_RUNTIME_CODEX_NO_PROXY` 中。
- Codex、Gemini CLI 和 Claude runner 已在创建子进程时恢复这组代理；新加入的 Antigravity runner 未复用该既有模式。

曾尝试在 `scripts/load-local-env.sh` 中把小写代理同步为大写，但该位置早于 interactive shell 注入代理，而且 Feishu runtime 随后仍会主动清除通用代理，因此不是正确修复点，最终已完整撤回。

## 修改内容

- 修改 `src/lib/real-agents/antigravity-agent.ts` 的共享 `childEnv()`。
- 优先保留子进程已有的标准代理变量；缺失时回退到小写变量，再回退到 Feishu runtime 为子 CLI 保留的 `FEISHU_RUNTIME_CODEX_*_PROXY`。
- 同时写入大小写两套 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和 `NO_PROXY`，兼容 Antigravity CLI 内部的 Go HTTP 客户端。
- 未修改 `agy -p`、`--sandbox` 或 `--dangerously-skip-permissions` 参数，也未改变 Feishu runtime 自身的网络环境。

## 验证结果

- `npx --offline tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过。
- `agent-platform-dev.service` 与 `agent-platform-feishu.service` 已重启。
- 用户从真实入口重新测试 Antigravity spawn，确认已经可以正常执行，不再要求重新登录。

## 对主线的影响

恢复了 Antigravity platform-local harness 在 Feishu Live Room 中的可用性。修复范围仅限 Antigravity 子进程环境，不改变其他 harness 或 Feishu runtime 的代理隔离策略。

## 下一步建议

返回开源准备主线。若其他新接入的本地 CLI 也需要访问代理网络，应在其 runner 的 child env 中复用相同的 `FEISHU_RUNTIME_CODEX_*_PROXY` 回退模式，而不是让整个 Feishu runtime 使用全局代理。
