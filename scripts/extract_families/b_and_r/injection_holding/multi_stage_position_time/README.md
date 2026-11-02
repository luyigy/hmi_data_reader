# B&R 射胶保压组合页

页面身份：`b_and_r.injection_holding.multi_stage_position_time`。仅代表已有实图的这一种组合布局，不代表全部 BOLE/B&R 页面。

| 文件 | 职责 |
| --- | --- |
| page_identity.py | 页面身份判断，不提取参数 |
| headers.py | 本页标题链证据 |
| layout.py | 射胶物理行列、物理段号和证据绑定 |
| holding_layout.py | 保压逻辑网格，区分预测位置与实测边框 |
| extractor.py | 读取绑定格中的字段，保留读数核验与段位核验状态 |
| observations.py | 当前 v1 字段及原屏观测输出 |
| verify_stability.py | 使用历史照片和冻结 OCR 回放，输出逐字段对照及证据，不调用新 OCR |
| raw_observations.py | 已有 v2 原屏识读及包完整性；保留原保守语义 |

公共 OCR、坐标投影和视觉证据在上层公共模块中；不要在其中解释 B&R 段位。
v1 与 v2 目前沿用各自既有读数逻辑，本次只整理、撤下其他页面，不宣称两者自动启用能力已经统一。
特别是 v2 对启用态仍保留 unknown，不因本次目录迁移自动变为 enabled。

活动模板：`templates/b_and_r/injection_holding.json`。
页面测试：`tests/pages/b_and_r.injection_holding.multi_stage_position_time/`。
真实照片及冻结 OCR 回放：本目录的 `verify_stability.py`。
新增其他页面时创建自己的 `<controller>/<page>/<layout>/` 目录，登记结构路由和受控提取器；不复制公共调度或添加 HTTP 页面补丁。

`__init__.py` 为包标记。回放命令：

```bash
.venv/bin/python scripts/extract_families/b_and_r/injection_holding/multi_stage_position_time/verify_stability.py --output /tmp/br-stability
```
