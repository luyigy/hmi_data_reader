# 68. CLAUDE_SPAWN_ENOENT_FIX_HANDOVER

## 日期

2026-04-07

## 本轮目标

修复 Feishu Runtime 中偶发的 `spawn claude ENOENT` 错误，导致 Claude 子进程启动失败、回复失败。

## 问题根因

`src/lib/real-agents/claude-agent.ts` 中的 `buildClaudeChildEnv()` 在构建子进程 PATH 时，只添加了**当前 Node.js 进程版本**对应的 nvm bin 目录：

```typescript
const nvmCurrentBin = `${nvmDir}/versions/node/${process.version}/bin`;
```

但 `claude` CLI 只安装在 `v22.22.1/bin` 下。当 systemd 服务用不同版本的 Node（如 v24.11.1 或 v22.21.1）启动时，构造出的 PATH 里没有 `claude`，导致 `ENOENT`。

服务器上有三个 nvm Node 版本：
- v22.21.1（无 claude）
- v22.22.1（有 claude ✓）
- v24.11.1（无 claude）

## 修复方案

改为读取 nvm versions 目录下**所有**安装版本的 bin 路径，全部加入 PATH：

```typescript
const nvmVersionsDir = `${nvmDir}/versions/node`;
let nvmBinPaths: string[] = [];
try {
  const { readdirSync } = require('fs') as typeof import('fs');
  nvmBinPaths = readdirSync(nvmVersionsDir).map((v) => `${nvmVersionsDir}/${v}/bin`);
} catch {
  nvmBinPaths = [`${nvmVersionsDir}/${process.version}/bin`];
}
```

这样无论 app 以哪个 Node 版本运行，`claude` 都能被找到。

## 修改文件

- `src/lib/real-agents/claude-agent.ts` — `buildClaudeChildEnv()` 函数，第 154-157 行

## 操作

修复后重启服务：

```bash
systemctl --user restart agent-platform-feishu.service
```

## 后续建议

如果未来给其他 Node 版本也安装了 `claude`，此方案自动兼容，无需修改代码。
