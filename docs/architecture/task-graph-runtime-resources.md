# 任务图运行资源声明

`.agent-platform/runtime.json` 是可选、随 Git 提交版本化的运行契约。没有声明时维持原流程；它不安装浏览器、下载 OCR 权重或增加主机权限。声明从当前 HEAD 读取，未提交修改不改变契约。

```json
{
  "version": 1,
  "browser": {
    "module": { "path": "node_modules/playwright", "sha256": "目录摘要" },
    "executable": { "path": "/已经批准的浏览器目录/chrome", "sha256": "文件摘要" }
  },
  "ocr": {
    "weights": {
      "kind": "output",
      "eventId": "本节点已有输出事件ID",
      "relativePath": "ocr-models",
      "sha256": "目录摘要"
    },
    "requiredFiles": ["weights.bin"]
  }
}
```

示例摘要必须替换成真实 SHA256。目录摘要按排序后的相对文件名和各文件摘要计算；链接、特殊文件、超出数量或字节上限的资源会被拒绝。

原生实施与逐仓平台检查按当前 Git 工作区的版本化声明预检；架构复核只对选定的工作区适用。独立验收 Agent 当前从非 Git 运行目录启动，不读取被验收源码仓的声明；不能据此声称所有复核阶段都已验证运行资源。多仓声明合成及独立验收的资源绑定需要后续单独实现和验证。

资源只能来自执行器已批准的只读目录；声明本身不授予新目录。浏览器启动使用固定本地页面进行冒烟验证，禁止自定义探测命令。OCR 验证摘要和必需文件，不保证识别精度。

预检回执位于本阶段输出目录 `runtime-preflight-<资源身份>.json`，记录提交、配置摘要、资源摘要及浏览器版本。输出资源使用原输出事件身份，归档迁移只改变物理路径。归档文件树必须与清单完全匹配，每次冷读取重新验证字节，可能增加大归档读取耗时。

缺少或不匹配资源是明确的准备失败；超时或短暂网络故障使用有限重试。具体重试与人工决定由统一执行状态处理。标准 Playwright 环境变量仅在匹配声明身份时进入沙箱。预检继承当前写入者 nonce，并在 Bubblewrap 的独立 PID 命名空间、父进程退出保护下运行。

现有业务仓库没有该声明时，不会静默修改它们的配置或审批快照。未来启用能力需要将资源绑定写入业务提交，并沿现有审批与权限流程生效。

## 验证

通用 PostgreSQL 回归包含中文故障卡片和归档产物测试。真实浏览器验证单独运行，要求安装 Playwright、playwright-core、Bubblewrap，并显式指定测试用 Chromium；这些路径只用于隔离测试的批准目录，不成为业务任务权限：

```bash
AP_RUNTIME_TEST_CHROMIUM_EXECUTABLE=/opt/google/chrome/chrome npm run test:task-graph-runtime-integration
```

模块路径从当前安装的 npm 依赖解析，不绑定开发机仓库路径。专用命令缺少浏览器路径时明确失败，不在通用测试中隐式依赖宿主浏览器。
