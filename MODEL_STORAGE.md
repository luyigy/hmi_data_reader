# 模型权重存放说明（2026-09-28 冻结）

结论：**大模型权重当前不搬迁**，仍放在旧仓 `/data1/code/hmi_data_reader/` 内。本文件在两仓（`hmi_data_reader`、`hmi_finetuning`）各存一份，改动时同步更新。

## 当前实际位置

| 内容 | 路径 | 大小 | 用途 |
| --- | --- | --- | --- |
| 基座 BF16 权重 | `/data/cache/modelscope/Qwen/Qwen3.8-27B` | 52G | 训练与合并的底座，已在 /data 盘 |
| 底座 AWQ（8003 服役） | `/data/cache/modelscope/cyankiwi/Qwen3.8-27B-AWQ-INT4` | — | 微调前对照服务，已在 /data 盘 |
| round2 合并 BF16 | `/data1/code/hmi_data_reader/output/exports/round2-bf16-20260928/model` | 52G | 量化母本，重新导出用 |
| round2 AWQ INT4（8004 服役） | `/data1/code/hmi_data_reader/output/exports/round2-awq-20260928/model` | 20G | 当前微调后推理服务 |
| round2 LoRA adapter + 训练产物 | `/data1/code/hmi_data_reader/output/training/round2-20260927-225021` | 516M | 训练报告、各 epoch adapter |
| AWQ 量化脚本/校准/验收证据 | `/data1/code/hmi_data_reader/output/exports/round2-awq-20260928/` | 随模型目录 | `REPORT.md`、`quantize.py`、校准清单等 |

## 服役依赖（删除前必须核对）

- **8004** `hmi-reader-round2-awq.service` 的 `ExecStart` 写死 `/data1/code/hmi_data_reader/output/exports/round2-awq-20260928/model`。**迁移完成并重启验证前，禁止删除该目录。**
- **8003** `vllm-Qwen3.8-27B-AWQ-INT4.service` 指向 `/data/cache/...`，与旧仓无关。
- 训练脚本 `scripts/train_small_sample.py` 的 `BASE` 指向 `/data/cache/modelscope/Qwen/Qwen3.8-27B`。

## 既定搬迁方案（暂缓执行）

目标结构（/data 盘，nvme 7T）：

```
/data/FineTuning/
└── hmi-reader/
    ├── round2-bf16-20260928/model     # 52G
    ├── round2-awq-20260928/model      # 20G（8004 服役）
    └── round2-20260927-adapter/       # 516M
```

搬迁操作清单（执行时逐项核对）：

1. `systemctl --user stop hmi-reader-round2-awq.service`
2. 复制三份产物到目标路径，校验文件数与总字节数一致（大权重建议抽校验哈希）
3. 修改 `~/.config/systemd/user/hmi-reader-round2-awq.service` 的 `--model` 为新路径，`daemon-reload` 后重启
4. 健康检查 + 1 张图推理冒烟通过后，才可清理旧路径
5. 同步更新本文件与 `output/exports/round2-awq-20260928/hmi-reader-round2-awq.service` 归档副本
