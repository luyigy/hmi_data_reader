# 已挂载 Node 依赖的预加载定位

原 W01 工作区保留的未提交线索经独立核对后，只采用 check-environment.ts 的通用依赖定位修复，没有采用 tsconfig.json 重排或新增全局编译配置。

红：新 Worktree 不含 node_modules，Bubblewrap 已只读挂载宿主原仓的依赖，但 `node -r ts-node/register/transpile-only` 仍报 MODULE_NOT_FOUND。完整失败见 node-preload-red.log。

绿：check 环境的 NODE_PATH 只取现有 graphDependencyPaths 返回、实际已经只读挂载的 node_modules，不接受 Agent 自建 symlink、不扩大挂载。源码与依赖写入仍被拒绝。项目自身 tsconfig 决定别名和编译选项，未注入平台通用 Prompt 或宿主执行回退。

命令：`node scripts/test-task-graph-postgres.mjs task-graph-check-node-environment`。已注册到现有必跑集合。真实 Bubblewrap 中删除继承的 NODE_PATH/TS_NODE 配置，加载依赖、解析源码别名、验证依赖不可写；node-preload-green.log 保存结果。原 W01 工作区中的未提交文件保持原状。
