# B&R 射胶保压页

本目录就是这一张页面的代码，不再往下机械增加布局名目录。完整注册 ID 仍为 `b_and_r.injection_holding.multi_stage_position_time`，ID 是稳定身份，不是 Python 文件路径。

## 从哪里读起

```text
确认页面身份 → 重建页面布局 → 读取字段 → 组装观测结果
page_identity.py  layout.py    extractor.py  page_result.py
```

| 文件 | 回答的问题 | 边界 |
| --- | --- | --- |
| page_identity.py | 图片是否有本页特有结构？标题链是否唯一？ | 不读取工艺数值，不推断启用段数；原 headers.py 的标题辅助合入这里 |
| layout.py | 哪些位置属于射胶/保压区、哪一行、哪一段？ | 统一放物理三行、保压逻辑网格、段号与像素证据；原 holding_layout.py 合入这里 |
| extractor.py | 对应格里读到了什么值、单位是否冲突、读数是否可信？ | v1/v2 读值入口都在这里，不管理包发布，不决定 mold 标准参数去向 |
| page_result.py | 怎样保留原值、状态和图像来源，并输出合同？ | 只接收读值结果，做来源/坐标/结果组装，不自行定位格子 |
| package.py | 使用哪一版字段定义和识读源码？ | 固定版本包与哈希校验，是交付配套，不是识图算法 |
| verify_stability.py | 已知照片的冻结 OCR 回放结果是否退化？ | 不重新运行 OCR，不证明未知照片准确率 |
| __init__.py | Python 包标记 | 无识读行为 |

这些文件按处理职责划分，不要求今后每页机械创建同样数量的空文件。不要按“漏一格、漏一行”再拆补丁文件。将来确有另一种页面布局时，先确认实图差异与身份，再选择可区分的页面目录名；不预建第三层空目录。

## 布局怎样重建

先读 layout.py 顶部的中文坐标词典，再按 A/B/C/D 小节阅读：

1. `physical_rows` 用真实边框排列三行，核对格宽、间距与错列。
2. `stage_identity` 核对最右格是否真为第一段，不把裁剪后剩余的最右格直接编号为第一段。
3. `build_holding_layout` 先从局部 OCR/标签/边框建立行列轴，再建逻辑格，再绑定观察证据。
4. 单格默认 `needs_review`。段位一致、OCR 归属唯一、没有离轴/标签/图像冲突后，空间映射才可为 `verified`。
5. 启用段数还需真实行末或两行联合 OCR 证据。数值是否读对、置信度是否够高，由提取层另查。

`predicted_bbox` 仅是候选位置；`observed_border_ids` 才表示检测到实体边框。空间映射通过不等于 OCR 数字正确，更不等于 mold 已接受写入。

教学示例，非现场准确率声明：速度行中心为 `[300, 200, 100]`，压力/时间行各两格，满足本页候选段数 `3-1=2`。印刷“1”唯一对齐到最右中心 300 可以确认段号；如果该处印刷的是“2”，应判冲突。右边被裁掉后，剩余中心 200 与已验证第一段参考 300 差一个列距，也不能冒充第一段。

## 真实版本边界

v1 路径使用物理三行和保压逻辑网格。v2 兼容路径的几何定位已归入 `build_raw_layout`，读值归入 `observe_bole_injection`，输出归入 `build_raw_observations`；它仍保留原冻结定义的区域与段号匹配算法，没有在本片改造成与 v1 完全相同的算法。未来新增页面应优先形成一套布局结果供不同输出合同适配，不复制这个历史兼容双路径。

v2 启用态仍保持 `unknown`，勾选项仍保留现有 `unsupported`，不是改目录就自动变为可靠值。新源码包为 `0.6.3`，原 `0.6.0`、`0.6.1`、`0.6.2` 包逐字节保留供历史导出；mold 未接纳新包。当前代码不能假装按旧源码身份运行。

## 入口与验证

活动模板仍在 `templates/b_and_r/injection_holding.json`；注册 ID、字段含义和模板路径未变。公共视觉、坐标投影和 OCR 仍在公共模块，不引入 B&R 特例。

页面测试在 `tests/pages/b_and_r.injection_holding.multi_stage_position_time/`，测试/证据目录可以使用完整 ID 关联身份，不要求和源码目录同形。

```bash
PYTHONPATH=scripts:. PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest tests/pages/b_and_r.injection_holding.multi_stage_position_time -q
.venv/bin/python scripts/extract_families/b_and_r/injection_holding/verify_stability.py --output /tmp/br-stability
```

## 交给 mold 的结果

`page_result.py` 组装页面识读结果，公共入口仍为 `scripts/raw_observations.py`。文件名已改为易读名称，但 JSON 的 `page_observations.v2` 等协议键和函数名保留，避免无意改变跨仓 API。Reader 原屏字段到 mold 标准槽位的实际对应关系、版本接纳与自动候选门槛见 [157 对接核查报告](../../../../docs/157_REPORT_20261102_Reader与mold字段槽位对接核查.md)。
