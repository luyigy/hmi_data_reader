---
doc_type: REPORT
doc_status: completed
next_action: none
---

# GPU0 Unsloth 双读服务

2026-09-25。用户要求启动候选模型服务用于双读，保持 8003 不动。

## 运行入口

- 服务：用户级 `hmi-unsloth.service`，监听 `http://127.0.0.1:8004/v1`，仅本机访问。
- 模型名：`Qwen3.8-27B-unsloth-bnb-4bit`。
- 权重：`/data/cache/modelscope/Qwen/Qwen3.8-27B-unsloth-bnb-4bit`，既有固定版本 `efd33fc8cf0d2973542650259250be0bf17fd3ed`；未训练、未转换、未修改权重。
- 推理：Unsloth 2026.9.11 + Transformers 5.5.0，BNB 4-bit / BF16，`CUDA_VISIBLE_DEVICES=0`，上下文加载配置 32768，关闭 thinking。
- systemd 配置源：`docs/hmi-unsloth.service`；安装到 `/home/hello/.config/systemd/user/hmi-unsloth.service`。本轮启动，不设置开机自启，避免未来训练与服务争用 GPU0。
- 双读环境：`docs/hmi-unsloth-dual-read.env`。只给单次双读进程使用，不改 molding-assist 的生产 `.env`。

```bash
systemctl --user status hmi-unsloth.service
journalctl --user -u hmi-unsloth.service -n 50 --no-pager
curl -fsS http://127.0.0.1:8004/v1/models
# GPU0 后续训练前先停此服务；训练结束按需 start。
systemctl --user stop hmi-unsloth.service
systemctl --user start hmi-unsloth.service
```

双读调用示例（输出文件必须不存在；不要附加 `--chat-id`，除非用户要求发送）：

```bash
cd /data1/code/molding-assist
set -a
source /data1/code/hmi_data_reader/docs/hmi-unsloth-dual-read.env
set +a
.venv/bin/python scripts/hmi_compare.py \
  --case-id case-031 \
  --review data/hmi-eval/dual-review/case-031-review.json \
  --output /data1/code/hmi_data_reader/output/training-prep/unsloth-service-20260925/case-031-next.json \
  --timeout 900
```

## 验收结果

- 文本请求成功返回 `OK`；真实图片、流式回复、技能工具交互与完整双读流程均已执行。
- `case-031-dual-read-v3.json`：A 路通过 `schema_version=1.0` 校验，46 个字段；B 路复用 2026-09-22 冻结复核的 26 个字段，来源和文件哈希保存在报告中。
- 比较：一致 15、分歧 4、未确认 51、失败 0。未确认计数包含语义和疑点条目，并非 51 个数值读错；一致也不代表人工确认。
- 保压速度段1/段2：新 A 均为 5.0%，冻结 B 为 6.0%；根据既有裁定，A 的这两项符合裁定。冻结 B 保留原始证据，没有回写裁定。
- 另外两处分歧是转保压位置/时间：A 将同名键用于启用勾选状态，B 用于数值；仍需人工确认字段语义及完整性，不能把格式通过当成精度验收。
- 本次使用原有 `hmi_compare.py` 的完整技能流程及图片处理；先前试跑为缩略到 1024 的单次提示。两者不是完全相同的推理条件，不直接比较准确率。
- 最小 CPU 检查：`/data/venvs/hmi-unsloth/bin/python -m tests.check_unsloth_service`，覆盖 XML/JSON 工具调用、非法参数及聊天模板选项；通过。Python 编译及 systemd 单元校验通过。

完整证据在被 Git 忽略的 `output/training-prep/unsloth-service-20260925/`：

- `case-031-dual-read-v3.json`：成功双读报告；之前两个 JSON 是兼容性修复前的失败记录，保留不覆盖。
- `case-031-a-overlay.png`、`case-031-b-overlay.png`：两路对照标注。
- `smoke_http.py`、`http-smoke.json`：固定服务真实图片复验入口与原始响应。
- `compatibility-probes.log`、`environment.freeze.txt`：失败探测日志与当前依赖快照。

## 兼容性处理与边界

1. 本机 vLLM 0.24 构建拒绝 bitsandbytes；0.19.1 在该混合量化权重加载时形状断言失败。没有修改任一共享 vLLM 环境或 8003 配置。探测时隔离安装的 BNB 包留在 `/data/venvs/hmi-vllm-bnb-deps`，正式服务不使用它。
2. Transformers 官方 serve 默认加载器生成时出现 `quant_state is required`。独立入口改为复用此前已验收的 `FastVisionModel`，HTTP、生成队列和流式协议继续使用官方服务实现。
3. `scripts/serve_unsloth.py` 仅做进程内适配：加载器/模型列表、视觉处理器的流式 tokenizer、Qwen3.5 XML 工具格式，以及客户端关闭 thinking 的模板选项。未修改 site-packages 或现有业务函数。入口依赖当前 Transformers 内部接口，升级前必须重跑真实图片和完整工具流程。
4. 在 `/data/venvs/hmi-unsloth` 增加 fastapi、uvicorn、openai 及其缺失依赖，原有训练依赖未升级；具体版本见 freeze。实际生成速度较慢，双读设置单请求 600 秒、整轮 900 秒，不适合作为高并发端点。
5. 8003 核实为用户级 `vllm-Qwen3.8-27B-AWQ-INT4.service` active，API 主进程 3224704、GPU1 EngineCore 3226297。先前“脱管”的说法不准确。本轮未重启、停止或修改该服务。
6. GitNexus query/impact 因数据库 43 与运行时 41 不兼容失败，风险为 UNKNOWN，不能声称图分析通过。新增入口没有现有业务调用者；直接调用来自新 systemd 单元，现有双读程序仅通过单次环境变量选择 8004。未提交 Git、未运行训练、未向群发送消息。
