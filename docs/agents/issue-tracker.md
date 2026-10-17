# Issue tracker: Gitee

本仓库的 Slice Issues 使用 `luyi1678/hmi_data_reader`，不从 Git remote 猜测 tracker。API 已核对仓库存在、Issues 开启及当前账户权限。

每条命令明确指定 `--hostname gitee.com -R luyi1678/hmi_data_reader --no-tui`。凭据由 `gitee` CLI 保管，不写入代码、文档或日志。Git 推拉认证与 Issues API 认证分别核对。

## 现有 HMI 原屏路线

- 父 Spec 在主仓：`gitee:luyi1678/mold-data-webpage-tool#IKMGQ4`。
- R02A：`gitee:luyi1678/hmi_data_reader#IKMGQC`，被主仓 S05 `gitee:luyi1678/mold-data-webpage-tool#IKMGQ9` 阻塞。
- R02B：`gitee:luyi1678/hmi_data_reader#IKMGQM`，被 R02A 阻塞。
- 后继 S06 在主仓：`gitee:luyi1678/mold-data-webpage-tool#IKMGQX`。

跨仓引用必须包含 provider、owner、repo 和 Issue 字符串 ID。关系使用版本化正文注释 `<!-- ap-ticket-v1 {JSON} -->`，包含 `version: 1`、`project`、`sliceKey`、完整 `parent` 和 `blockedBy` 数组。Gitee 此兼容格式不等同于原生 blocked-by UI。

创建或修改前先读取已有单据及稳定发布标记；超时后先对账，避免重复。依赖只在 tracker 编写，平台从真实单据生成并冻结获批来源，拒绝缺失引用、重复和循环。关闭 Issue 不代替验收或集成。

本轮关联保留原批准的固定提交 `3e01a433a81f2826ae1b27b3a8600084435c4a2c`，不包含主工作目录的未提交修改。该配置文件不授权启动 R02A/R02B；须等待 S05 达到原批准的完成条件，平台再派发独立任务工作区。实施、检查和验收复用该任务工作区；失败保留现场，完成保存证据后清理。

## 常用操作

- 读取：`gitee issue view <ID> --hostname gitee.com -R luyi1678/hmi_data_reader --no-tui --json=number,title,body,state,labels`。
- 列表：`gitee issue list --hostname gitee.com -R luyi1678/hmi_data_reader --no-tui -s all --json=number,title,state`。
- 写入操作须有用户任务授权。评论、编辑或关闭前读取最新单据，保留他人内容；创建票据不等于批准执行。

历史 PLAN/HANDOVER 只作背景材料。本路线由平台的已批准任务图与执行账本推进，不通过交接文档启动下一会话。
