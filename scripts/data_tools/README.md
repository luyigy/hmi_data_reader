# data_tools 目录说明

管理图片、标注、候选样本和评测数据。这里准备数据，不实现页面识读规则。图片和标注继续留在原数据目录，本次只移动工具代码。

| 文件 | 作用与执行影响 |
| --- | --- |
| `aggregate_record.py` | 聚合同一采集记录的 OCR，形成控制器候选报告；读取已有 OCR，可写本地报告。 |
| `datasets.py` | 治理 calibration、holdout、regression 数据集；check 只校验，build 会更新数据集元数据与发布清单。 |
| `feishu_source.py` | 飞书样本查询和附件下载基础函数及命令行；需要飞书凭据，会联网并写本地图片。 |
| `download_training_images.py` | 按清单限量下载训练候选图片；不会自动接受标注或划分训练/测试集合。 |
| `prepare_training_packet.py` | 生成可人工复核的训练图片/标注包；写本地目录，保留已编辑标注。 |
| `prepare_training_review.py` | 盘点既有标签并生成训练复核材料；不把历史模型输出自动升级为人工真值。 |
| `package_reviewed_evaluation.py` | 包装已经目视复核的评测答案；写本地评测文件，不训练或加载 GPU。 |
| `build_evaluation_sets.py` | 建立和检查评测集及相关元数据；写本地数据，运行前先核对清单和输出位置。 |
| `audit_evaluation_candidates.py` | 使用 CPU 审计候选评测证据与图像；生成本地审计结果。 |
| `download_images_batch.py` | 限量分批下载飞书附件，校验图片、去重、保留 checkpoint；继承旧 s054 批次目录，不自动生成真值。 |

`__init__.py` 仅标识 Python 包，不启动任务。推荐从仓库根目录使用 `python -m scripts.data_tools.<模块名>`；有命令行参数的工具可先查看 `--help`。多数工具也支持直接执行文件。不要用“导入所有模块”验证这些工具，部分既有程序会在导入时读取本地实验输入。
