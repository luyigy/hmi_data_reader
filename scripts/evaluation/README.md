# evaluation 目录说明

评测与批量回放工具。冻结 OCR 回放、真实在线 OCR 和人工确认后的结果必须分别记录。B&R 专属回放位于页面目录的 verify_stability.py。

| 文件 | 作用与执行影响 |
| --- | --- |
| `verify_accuracy.py` | 把 Reader 输出与冻结真值逐字段比较；读取本地结果，可写评测报告。 |
| `score_relations.py` | 按已确认的参数语义、值、单位、角色和位置计算评分；不推断真值。 |
| `vlm_eval.py` | 调用 VLM 对已有真值集评测；会请求配置的模型服务，输出字段级报告。 |
| `vlm_text_eval.py` | 离线评测 OCR 文本到字段的映射；会调用配置的文本模型，不接在线生产提取入口。 |
| `recognize_batch.py` | 串行上传本地图片到 Reader，保存原始响应和提取结果；--input-dir/--output-dir/--url 指定新批次，旧 --batch-id 仍可读取旧目录。 |

`__init__.py` 仅标识 Python 包，不启动任务。推荐从仓库根目录使用 `python -m scripts.evaluation.<模块名>`；有命令行参数的工具可先查看 `--help`。多数工具也支持直接执行文件。不要用“导入所有模块”验证这些工具，部分既有程序会在导入时读取本地实验输入。

批量识别示例，执行时会上传图片到指定 Reader：

```bash
python -m scripts.evaluation.recognize_batch --input-dir /path/to/images --output-dir /tmp/hmi-batch --url http://127.0.0.1:8765/api/v1/recognize
```

输出目录和服务端应由使用者确认；历史 `--batch-id` 模式仍保留原批次目录，不移动或覆盖已有数据。
