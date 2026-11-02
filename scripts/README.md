# scripts 导航

当前 Reader 只支持 B&R 射胶保压页。顶层保留公共运行模块，工具按用途进入子目录；不要再把新的一次性阶段脚本平铺到这里。

| 目录 | 内容 |
| --- | --- |
| [data_tools/](data_tools/README.md) | 管理图片、标注、候选样本和评测数据 |
| [training/](training/README.md) | 训练、模型下载及试验推理服务 |
| [evaluation/](evaluation/README.md) | 评测与批量回放工具 |
| [diagnostics/](diagnostics/README.md) | 供人工定位问题和查看证据的工具，不参与在线页面路由决策 |
| [integrations/](integrations/README.md) | 与外部系统交互的入口 |
| [operations/](operations/README.md) | 离线流水线与页面管理命令 |
| [extract_families/](extract_families/README.md) | 页面插件及公共视觉原语 |

## 顶层运行文件

| 文件 | 作用 |
| --- | --- |
| `classify_ui.py` | 从 OCR 判定控制器及页型候选，候选不等于页面已支持。 |
| `contract.py` | 为输出附加统一字段目录、页面身份和置信信息。 |
| `controller_binding.py` | 核验已确认的机台绑定和固定页面包。 |
| `dedup.py` | 按图片内容哈希去重。 |
| `export_page_package.py` | 导出固定版本页面包供审核和回放。 |
| `extract_fields.py` | HTTP、CLI 与集成共用的提取编排入口。 |
| `extract_generic.py` | 离线 VLM/文本工具复用的保守解析能力，已退出未知页在线提取。 |
| `extractor_registry.py` | 受控提取器 ID 与代码入口注册。 |
| `ocr_one.py` | 单图 OCR，保留文本、框及置信度。 |
| `ocr_variants.py` | 公共 CLAHE 图像增强与 OCR 证据辅助。 |
| `page_identity.py` | 独立页面身份路由，拒绝未知和冲突。 |
| `page_template_registry.py` | 按活动注册加载页面模板。 |
| `postprocess.py` | 公共 OCR 文本后处理。 |
| `quality.py` | 图片质量门禁和屏幕检测。 |
| `raw_contract.py` | v2 原屏包与原屏记录的完整性校验。 |
| `raw_observations.py` | 分发受支持页面的 v2 观测。 |
| `raw_page.py` | 公共 OCR 框与内容哈希原语。 |
| `raw_page_ocr.py` | 记录 OCR 引擎身份。 |
| `rectify.py` | 屏幕透视矫正。 |
| `vlm_qwen.py` | VLM/文本模型客户端，在线可选候选与离线工具共用。 |
| `run_service.sh` | 启动公共 HTTP 服务，维持原路径 |

每个子目录的 README 列出脚本作用及副作用。已过期的阶段编号脚本和旧夜间调度器已删除，历史代码可从 `backup/reader-before-tools-cleanup-20261102` 查看。图片、真值、模型及训练产物未移动。仓库中的 systemd 示例已更新模块路径，安装中的配置没有自动更新，也没有重启服务。

完整离线回归：

```bash
PYTHONPATH=scripts:. PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest tests -q
```
