# 运行资源跨阶段连续性

版本化的浏览器及 OCR 声明现在按当前 execution claim 固定。实施、平台检查及非 Git 验收目录使用同一个资源身份，不按验收工作目录重新猜测工具。

## 显式登记现有工具

项目内已纳入 Git 的 `.agent-platform/runtime.json` 优先。显式项目配置无效、未提交或资源损坏时直接失败，不回退宿主工具。

项目没有声明时，可由平台运维在现有主仓的权限登记之外，登记工具声明：

```json
{
  "/canonical/project/repository": {
    "version": 1,
    "browser": {
      "module": { "kind": "path", "path": "/approved/playwright-bundle", "sha256": "实际目录SHA256" },
      "executable": { "kind": "path", "path": "/approved/chrome/chrome", "sha256": "实际文件SHA256" }
    }
  }
}
```

文件为平台工作目录的 `config/runtime-resources.json`。键必须等于服务从账本和 Git 身份核实的主仓真实路径。这里登记的是已有资源，不扫描、下载或安装宿主工具。

权限仍由 `config/runtime-environments.json` 的旧数组格式或原 workflow 批准提供：

```json
{
  "/canonical/project/repository": ["/approved/playwright-bundle", "/approved/chrome"]
}
```

声明不能授予权限。旧数组格式保持不变，仍在运行的旧服务不会因新登记而解析失败。显式 workflow 权限优先，不从可变宿主配置增加根目录。已有 workflow 批准的项目声明及只读根可随 claim 延续到后续阶段。

## 固定与验证

首次使用先在节点锁外完成资源摘要和浏览器冒烟检查，再在原节点锁内核对 claim、revision、候选、阶段及 writer 身份，并重查源码真实路径、Git common directory、HEAD 和声明哈希。

通过后追加 `runtime_snapshot_pinned` 事件。事件固定声明来源、声明提交、内容哈希、资源路径与 SHA256、有效只读授权摘要、资源身份及预检回执。显式宿主登记另保存登记文件字节哈希和平台代码提交。平台代码提交仅说明解析代码版本，不声称本机配置文件已经提交到 Git。

后续使用仍重新验证字节和权限。源码候选可以正常推进，只要项目声明保持原哈希。相同资源在派生 worktree 中保持相同身份。相对路径仅能在已核实的当前候选源码中重新解析，不能转向任意宿主目录。

现有宿主登记或权限文件的后续变化不会扩大当前 claim；新配置只能由新的受控 claim 使用。最初没有声明的 claim 保持无声明，同时保留其原有只读授权。当前调用若带更窄的显式 workflow 权限，旧授权不能绕过它。

浏览器临时目录使用沙箱私有 `/tmp`，避免深输出路径触发 Chrome Unix socket 路径限制。缓存及报告使用阶段输出目录。源码、原图及声明资源保持只读。共享 Python 环境继续按原主仓规则解析；这不等于冻结 Python 依赖字节。

## 验证入口

```bash
npm run test:task-graph-postgres -- task-graph-runtime-pinning task-graph-runtime-inputs
TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/task-graph-runtime-continuity.test.ts
```

第二项使用已安装的真实 Playwright 和 Chrome。可用 `AP_RUNTIME_TEST_CHROMIUM_EXECUTABLE` 指定测试机器的真实 Chrome。测试不会下载资源。

证据在 `docs/evidence/runtime-continuity/`。先提交的红色测试实际启动源仓浏览器，随后证明非 Git 验收丢失声明。绿色测试覆盖真实浏览器的源仓、非 Git 验收及派生 worktree，显式缺失和 Snap 包装拒绝，源文件及资源只读、输出可写与私有临时目录。

PostgreSQL 测试使用独立 schema，覆盖原生 harness 调用方、平台沙箱检查、非 Git 验收、宿主变更不扩大权限、workflow 限制、无声明兼容、资源和配置变更、源码 HEAD 竞争及账本 revision 竞争。原有主仓 Python 环境测试也必须通过。

## 当前范围

不同仓库给同一联合阶段提供不同资源身份时，拒绝隐式合并，应按仓库分别验证。过期物理路径不会自动重定向；产物迁移仍需现有事件及归档验证。该实现不新增推进状态机、Issue 投影或恢复授权入口，也不证明 OCR 识读准确率或任何业务票已验收。
