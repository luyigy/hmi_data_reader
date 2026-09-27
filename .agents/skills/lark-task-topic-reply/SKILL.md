---
name: lark-task-topic-reply
description: 将复核图片、文件和说明发送到 Agent Platform 飞书任务房间绑定的话题，并回读核验归属。适用于“发到咱们这个话题/任务群”，避免误发大群主时间线。
---

# 任务话题内回复

先读当前环境的 `lark-im` 与 `lark-shared` 技能。仅在用户要求发送时执行发送；创建或阅读本技能本身不授权发消息。既有会话已授权的发送范围继续有效。

## 定位当前话题

从本轮房间上下文、平台绑定或已核验发送记录取得三件套：群 `chat_id`、话题 `thread_id`、根消息 `root_message_id`。只知道大群名字不足以定位任务。用根消息回读核对标题、群和话题；冲突时停止发送并查绑定，不退回大群。

“准备hmi页面识别训练集”房间在 2026-09-27 的已核验绑定如下，只适用于这个任务，其他房间必须重新取绑定：

```text
chat_id = oc_5c8067219168958335bfc59d5fbb2b11
thread_id = omt_19d207da838f1a4b
root_message_id = om_x100b644cbff7d4a0de7bfb226961961
```

依据：`output/reviews/user-image-review-20260927/state.json` 的 `channel`；根消息内容为本任务卡片，已用飞书读接口重新核验。

## 命令

使用发送 bot 自己的独立配置，不覆盖其他 bot。此房间已验证的本地AI助手配置是 `/home/hello/.lark-local-ai`；其他机器先确认当地配置。不要读取或输出凭据内容。

```bash
export LARKSUITE_CLI_CONFIG_DIR=/home/hello/.lark-local-ai
TASK_ROOT=om_x100b644cbff7d4a0de7bfb226961961
TASK_THREAD=omt_19d207da838f1a4b

# 只输出定位所需字段，避免根消息自动展开大量历史回复。
lark-cli im +messages-mget --message-ids "$TASK_ROOT" --as bot --no-reactions \
  --jq '.data.messages[] | {message_id,chat_id,thread_id,content,deleted}'

# 以下仅为已获发送授权后的示例；内容/文件替换为实际待发物。
lark-cli im +messages-reply --message-id "$TASK_ROOT" --reply-in-thread \
  --image ./review.jpg --as bot
lark-cli im +messages-reply --message-id "$TASK_ROOT" --reply-in-thread \
  --text '样本编号及需裁定的问题；唯一批次标记' --as bot
```

每一条图片、说明和附件都带 `--reply-in-thread`。`--message-id` 使用 `om_` 根消息，不把 `omt_` 话题 ID 当作消息 ID。不要用 `+messages-send --chat-id` 代替：它会发到大群主时间线。普通引用回复不等于话题内回复。

## 验收与重试

保存每次返回的 `message_id` 和收据。发送一条后先回读，确认 `chat_id`、`thread_id` 与目标完全相同、内容正确，再继续下一条：

```bash
lark-cli im +messages-mget --message-ids om_REPLACE_WITH_SENT_ID --as bot --no-reactions \
  --jq '.data.messages[] | {message_id,chat_id,thread_id,content,deleted}'
lark-cli im +threads-messages-list --thread "$TASK_THREAD" --order desc --page-size 10 --as bot
```

超时或收据缺失时先按唯一批次标记查话题，确认未送达才重试；不重复发整批。核验话题错误则停止后续发送，报告实际位置，按用户授权及 lark-im 撤回规则处理误发。发送成功只证明送达，不证明用户已确认。

生成 HMI 左右对照图片用相邻 `hmi-review-pair` 技能。消息发送记录保留在项目 `output/reviews/<批次>/`，不要把鉴权信息放进共享技能。
