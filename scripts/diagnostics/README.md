# diagnostics 目录说明

供人工定位问题和查看证据的工具，不参与在线页面路由决策。

| 文件 | 作用与执行影响 |
| --- | --- |
| `annotate.py` | 在图片上画 OCR 框、文本及置信度；写本地标注预览图。 |
| `classify_with_postprocess.py` | 对已有 OCR 运行后处理及控制器候选分类；不提供其他页面的字段提取支持。 |
| `explain_case.py` | 解释单张图片的提取结果和真值差异；读取已有本地 OCR 与真值。 |
| `check_candidate_http.py` | 检查隔离验证台与 Reader 的候选 HTTP 链路；会创建测试批次，只对明确隔离的环境使用。 |

`__init__.py` 仅标识 Python 包，不启动任务。推荐从仓库根目录使用 `python -m scripts.diagnostics.<模块名>`；有命令行参数的工具可先查看 `--help`。多数工具也支持直接执行文件。不要用“导入所有模块”验证这些工具，部分既有程序会在导入时读取本地实验输入。
