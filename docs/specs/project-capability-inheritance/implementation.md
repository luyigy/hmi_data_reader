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
