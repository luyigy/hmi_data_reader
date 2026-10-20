# A 的隔离验证

基线 `bbc574d`。独立 worktree `feat/ticket-agent-autonomy-ab`，临时 PostgreSQL schema，无生产账本写入或服务重启。

- 红：`node scripts/test-task-graph-postgres.mjs task-graph-skill-runtime`，退出 1。旧声明解析拒绝完整技能包需求。原始沙箱不可读证据沿用 513 的 skill-probe.json。
- 绿：`AP_TEST_POTETO_PACKAGE=/home/hello/.codex/skills/poteto-mode AP_TEST_POTETO_ADAPTATION=/data1/code/hmi_data_reader/.agents/playbooks/ap-task-graph.md node scripts/test-task-graph-postgres.mjs task-graph-skill-runtime task-graph-runtime-pinning`，退出 0。环境变量只为额外真实安装包 smoke 提供位置，普通夹具不依赖该业务仓。
- 实际严格 Bubblewrap 内读取正文、Codex 映射和四份 playbook，运行固定包内检查脚本并核对项目适配；包不可写，未授权宿主文件不可见。只授权入口 symlink 所在目录不能授予目标包权限。
- Native Harness 调用缺少必需映射时预检拒绝，模型调用数为 0。旧运行资源固定、非 Git 验收、声明漂移和 CAS 回归通过。
- `task-graph-sandbox`、`project-capabilities-c01`、`project-capabilities-c02` 通过，后者日志见 a-regressions 的本地输出；类型检查和长文件守卫通过。

接口继续使用现有版本化运行声明、权限交集、claim pin 与 Bubblewrap 构造器。没有新增沙箱例外或自动放行链接。宿主包必须有精确目录授权，声明不能自授权限。

本步只完成 Runtime 代码与隔离回归。没有给生产任务添加声明、授权或恢复记录。真实 Codex/Topic 验收留待 B 后，尚未完成。
