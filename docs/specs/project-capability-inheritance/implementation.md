# 项目能力实现与验证

## C01 已实现范围

平台按主仓身份读取宿主 `~/.agent-platform/project-capabilities.json`。工作区中的配置不能授予宿主权限。路线提议在确认前将项目能力哈希、资料源别名和只读目录写入每个 execution 的 `capabilities`，确认后不能静默扩大。

当前只启用有批准范围的任务图执行。普通任务、缺少范围的旧 Run 不会因项目 owner 有权限而自动得到新能力。C02 负责其他入口与兼容迁移。

执行进程通过每轮私有 Unix socket 查询资料。平台检查路线范围、当前应用、批准人、接续消息作者和 claim。沙箱看不到飞书凭据，无须开放业务网络。接口只提供已登记资料源的查询和选图，没有任意 URL、CLI 或群发接口。

本地图集只读挂载。远端图片按需缓存，下载前核对原查询范围及附件版本，只把选中图片发布到任务只读目录。缓存命中仍重做授权检查。每份输入保留记录、字段、附件身份、内容哈希和事件，不替换旧材料。授权撤销阻止后续请求，但不能收回进程已经读到的字节。

最终答复中的实际图片路径经宿主校验后，复用附件投递账本发送到任务绑定话题，并回读群、话题和 image key。不确定投递不自动重发。图片失败不删除文字，平台另外记录可见处理说明。卡片中的图片语法转换为文字或链接，防止 ErrCode 11310。

## 宿主配置示例

管理员在沙箱不可写位置创建文件。以下占位符须替换为实际批准范围，不应复制整个 HOME 或凭据目录。

```json
{
  "version": 1,
  "projects": [{
    "repository": "/absolute/canonical/main-repository",
    "appId": "cli_APPROVEDAPP",
    "principals": ["feishu:cli_APPROVEDAPP:ou_APPROVEDUSER"],
    "readOnlyRoots": ["/absolute/canonical/image-directory"],
    "sources": [{
      "key": "training",
      "baseToken": "APPROVEDBASE",
      "tableId": "tblAPPROVEDTABLE",
      "searchField": "品牌",
      "imageFields": ["成型条件-储料/冷却"]
    }]
  }]
}
```

新路线在提议卡显示资源范围。需要缩小范围时在 execution 的 `capabilities` 中显式列出子集。项目配置变化会拒绝旧范围，须明确重新批准，不能把仓内声明当授权。

## C01 证据，2026-10-20

- PostgreSQL 隔离 schema 内的 C01、proposal、runtime-pinning、reply-summary 测试通过。
- C01 使用真实 Bubblewrap，关闭业务网络后仍可通过 socket 查询和读图。覆盖未授权资料源、普通任务不隐式授权、缓存撤销、附件版本变化、授权接续作者、符号链接、重复发送和回读错话题。
- 真实飞书表格查询返回伯乐记录 `recuQJJFYYwEDU`，按需下载 JPEG 5,390,849 字节。已实际打开核对为熔胶页面。
- 同一图片经新发送函数投递并回读，消息 `om_x100b6250e2273ca4b07eb78ded97f97`，群 `oc_5c8067219168958335bfc59d5fbb2b11`，话题 `omt_19b17eee438f1b45`，与 R05 已核验绑定一致。
- 完整链使用隔离 schema 中的测试 execution 和临时授权，不写生产任务账本。原图与发送意图/回执保存在实施 worktree 的 `output/reviews/project-capabilities/c01-live/`，不入 Git。
- 静态权限复核通过；TypeScript 检查和长文件守卫通过。

真实发送仅证明资料和图片通路，不代表 R05 独立验收通过。本轮未重启或热加载服务，未续跑业务节点，未创建生产项目授权。分支部署和旧 Run 授权迁移仍需完成。

## 部署与回退

本分支依赖已提交的原任务会话接续实现，无数据库结构迁移。服务切换应在确认活动 writer 状态后统一部署，不在运行途中替换模块。部署前用只读诊断确认兼容版本和批准范围。

回退通过新增恢复提交或切回上一已知服务版本进行，不改写 Git 历史。暂停新能力入口并保留材料、附件和任务账本；投递不确定时先对账，不重复发送。

## C02 已实现范围

C02 在 C01 提交之后实施，覆盖本机任务图的实施、平台检查、独立架构复核、验收及原话题接续。普通非任务图任务保持既有授权行为，不因 owner 相同而获得资料权限；远程执行器未新增能力。

已登记项目以 C01 的有效能力解析为唯一新授权来源。旧 `runtime-environments.json`、`runtime-resources.json` 只为未登记项目提供兼容路径。项目授权被撤销后，不能回退到旧配置重新得到权限。

- 浏览器/OCR 使用宿主项目配置的可选 `runtime`，格式与版本化 `runtime.json` 相同，保留资源 SHA256 和真实沙箱预检。仓内显式声明仍优先且受目录授权限制，无效时不能静默换成宿主浏览器。
- 每个 claim 保存工具声明、资源身份和授权来源。实现候选改变而工具声明不变时可复用；声明、资源或授权改变时拒绝静默切换。
- Python 继续解析主仓 `.venv` 或 `project-environment.json`。登记项目必须另外批准这个环境目录。新 claim 固定目录选择、解释器字节及环境配置身份，Bubblewrap 不再自行重新挑选目录。此身份不覆盖全部 site-packages；宿主管理员必须维持已发布环境不可变，更新包时发布新的环境目录。旧 pin 缺少 Python 字段时保留旧语义，不伪造已有版本证明。
- 多仓复核按具体 execution ID 解析权限。同仓两项任务也不能串用资源范围。资料源用 `<仓内任务键>/<别名>` 区分；不同工具/Python 环境通过 `AP_PROJECT_TOOL_RUNTIMES_JSON` 提供，禁止隐式选择全局环境。脚本在同一个已受限沙箱内按对应 `env` 启动，不通过宿主执行任意命令。
- 平台实施检查、合流检查和验收集成检查传递实际 worker nonce。缺少身份时明确拒绝新资料接口，不静默降级为空能力。检查和验收的源码仍只读，输出仍按既有 attempt 隔离。
- 合流检查前，协调器通过原 claim/revision CAS 记录刚生成的合并候选。此前账本仍指向合并前提交，会错误拒绝真实合并源码。冲突保留、引用 CAS 和独立验收门禁保持有效。

### 旧 Run 的受控兼容

旧 Run 不因登记项目而自动扩权。以下宿主运维命令默认只读，检查批准人、配置哈希、当前候选、旧工具快照及 writer 证据。

```bash
npm run project-capabilities:scope -- --execution-id=<实际 execution ID>
```

只有平台管理员审核预览、确认资源范围，且 writer 已退出，才可显式应用。

```bash
npm run project-capabilities:scope -- --execution-id=<实际 execution ID> --apply --policy-hash=<预览的完整哈希>
```

应用仅追加 `project_capability_scope_approved` 事件。原路线 snapshot、候选、预算、阶段和工作区不变，也不会启动 TaskRun。重复应用幂等。旧工具 pin 必须与新批准声明和目录兼容且被回执明确列出，才能沿用原身份；不兼容或无法证明 writer 退出时保留现场并报告，不能自动改写原快照或盲目重置预算。

本轮没有对生产 Run 执行该迁移，没有创建生产项目授权。

### C02 验证，2026-10-20

- 新项目能力挂载不会自动追随目录内的符号链接扩大授权。真实 Bubblewrap 探针确认正常原图可读，链接指向的未授权文件不可见。
- 新增 `project-capabilities-c02` 使用真实 Git worktrees、PostgreSQL 隔离 schema、Bubblewrap 和两个独立 Python 环境。验证实施与非 Git 验收、平台检查的工具身份及源码只读。
- Reader/Mold 场景是隔离夹具，不是两仓业务完成。夹具证明 Reader 等人时 Mold 仍可完成；两侧验收证据齐备后原后继变为 ready，没有依赖 Issue 标签推断交付。
- 验证不同工具身份的多仓复核、同仓 wide/narrow 资料范围、Python 配置变更、跨应用/跨用户拒绝、撤销不回退旧授权，以及迁移时活动 writer 拒绝、退出后幂等追加且不改候选/预算。
- 用 `AP_CAPABILITY_BROWSER_PROBE=1` 在同一夹具中加入宿主已登记的真实 Playwright/Chrome，执行实际沙箱浏览器预检。没有采用 Snap 包装器或测试浏览器替身。
- 真实协调器自动完成回归在 C01 基线复现了合并候选登记缺陷。修正后，失败自动回修、独立支线和后继均通过，人工 resume 次数为 0。
- 合流重试/CAS、固定运行资源、检查失败与超时测试通过。原话题回复、路线审批和卡片摘要回归另行验证。
- 架构复核已确认多仓身份、writer nonce、旧 pin 迁移和合并候选 checkpoint 未绕过现有边界。

两片代码均可独立检查提交。线上部署仍未执行，生产 Reader/Mold 业务流程未完成端到端验收；不能将上述隔离测试解释为线上任务已经恢复。切换时先确认活动 writer、准备宿主项目配置、审查旧 Run 的只读迁移预览，再统一部署；继续保留原业务候选和账本。
