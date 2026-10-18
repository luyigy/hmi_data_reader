# R01 本轮实施记录

本轮结论为 blocked，原因是 missing_business_material。R02 复用和真实行为盘点已保存，完整原屏 v2 尚未实现，不应集成或放行后继。

## 材料门

`material-inventory.json` 对仓内 ground_truth、datasets 图片逐字节计算 SHA-256，再与 templates/samples 的全部 9 份声明比对。8 份声明没有匹配原图。DEMAG 保压 Z002_ab30f6f6 有两个内容相同的原图路径，不能算两个样本。

该图 SHA-256 为 `186a514d33458a612eee4479082a2f731cbabf93168f39d8119f11ced5931676`。领域真值文件 ground_truth/demag_holding/holding_Z002_ab30f6f6.truth.json 的 SHA-256 为 `b2e3364d636067b5f0b19b1b19b4c1025afa6fb38dd376ca628d457a8bcf9755`。

真值只包含保压压力 65/50/0、时间 2/3 和速度 15/10/5，并明确第三段压力 0 为禁用残值。原图还显示实际切换 38.0 bar、保压 53.1 bar、位置/余料量 12.52 mm、额外灰显槽位及其他数值。这些可见内容没有完整逐字段真值、稳定物理身份和经核实页面元数据。没有把目视推测升级为领域裁定，也没有把历史部分核实范围改写为整页通过。

恢复需要平台提供或绑定一页真实原图及完整原屏真值和页面身份裁定，可补齐此图，也可指定已有完整代表页。固定输入清单的 inputs 为空。本记录不要求用户重复上传图片，也不推断归档中缺少的材料从未在其他版本验证。

## 已保存改动

工作区基线为 `63054287203bbceb7d07d3d96520eb4ede2dc235`。与 R02 的共同祖先为 `3e01a433a81f2826ae1b27b3a8600084435c4a2c`。

逐提交读取并检查 `c5aa25a752d7912f114e30970c55b594346dd0f5` 与 `982ef2d021286ffff4e2e352af68b2efd6f0bf77` 的补丁，先运行 git apply --check，再仅向当前工作文件应用。`reuse.json` 保存补丁哈希；`source-verification.json` 证明 14 个复用文件当前字节与 982ef2d Git 对象一致。没有重写注册或发布能力。

新增 tests/test_hmi_protocol_library_r01.py。该入口以真实图片、真实 CPU OCR、实际脚本子进程和 ASGI HTTP multipart 上传检查 Reader 行为，并保留暴露缺口的失败断言。未固定新的公共 v2 schema 或发布任何新包。测试中的 raw_field_definition/raw_contract 是待实现导出检查，不代表双方已经接纳的合同版本。

合流 SHA 尚不存在。Git add/commit/merge 均未执行，平台拥有检查点和集成权限。Model 只读仓 HEAD 为批准的 `bc3f7069f6bf973c04ffb9fde3bbb3f21c18bdd0`，其未跟踪的 .agent-platform 与 contracts/hmi-reader/process-screen 未作为交付输入。未写原仓或额外仓。运行时原仓视图没有部署现场的未提交源码，不能证明与历史部署脏文件逐字节相等。

## 实际验证

| 命令或行为 | 实际结果 | 证据 |
| --- | --- | --- |
| node /home/hello/.codex/skills/poteto-mode/scripts/check-playbooks.mjs | Every project playbook matches this pstack's playbooks. | todo.md、read-versions.json |
| gitnexus analyze --index-only --skip-git --name hmi_data_reader --workers 2 | 建立工作区索引，无 AGENTS/技能文件注入 | gitnexus-impact.json |
| 指定 Python -m pytest -q tests/test_r02_extractor_registry.py tests/test_r02_template_lifecycle.py tests/test_demag_page_contract_baseline.py | 50 passed | reuse-tests.log |
| /data1/code/hmi_data_reader/.venv/bin/python -m pytest -q tests/test_hmi_protocol_library_r01.py | 2 passed, 2 failed，退出码 1 | ticket-behavior.log |
| 指定 Python -m pytest -q tests/test_contract.py tests/test_page_template_admin.py | 21 passed，22 subtests passed | additional-regression.log |
| 原脚本 scripts/ocr_one.py，真实原图 | 默认 GPU 初始化失败；未将其当作识读通过 | live-ocr.log |
| PaddleOCR(use_gpu=False)，真实原图 | 实际读出 45 行；后续验收入口使用同一 CPU 参数 | cpu-ocr.json、cpu-ocr.log |
| 实际脚本抽取与 HTTP 上传 | 两个入口均选中 DEMAG 保压页，并读出已核实压力 65/50/0；HTTP 质量为 green | live-script.json、live-http.json、live-lines.json、live-rectify.json |
| 固定旧包离线回放 | 禁止 Path 图片/模板读取及 socket connect 后，结果哈希仍为 eddc3f3f5efa4b466ad7432d1850e8054612d5eda7a8a65e5740100c1b3d1750 | 指定行为入口的 v1 回放用例 |
| git diff --check | 通过 | 最终命令执行 |

HTTP 使用真实 ASGI 路由、multipart 解析及真实 OCR 模型；没有启动部署服务，也没有声称访问线上 Reader。生命周期启动被替换为显式装载真实 CPU 模型，识读、矫正、分类和字段提取没有伪造。脚本验证使用实际 extract_fields.py 子进程。离线回放使用固定 OCR 夹具，与实时识读分开。

失败一是原屏观测缺 source/reading、真实坐标和明确禁用态。真实 HTTP 的八个字段仍全部 state=unknown、original_bbox=null。失败二是现有导出包没有完整离线原屏字段定义及 v2 合同身份。exported-package.json 是旧 v1 包证据，含历史 business_profile_candidate，不能冒充不含业务规则的新公共合同。

## 联合验收范围

| ID | 本轮状态 |
| --- | --- |
| A01 | Reader 实时识读、HTTP 和脚本部分执行；Model 原屏保存、预览、确认、独立 GET、退出重开未执行。 |
| A04 | 未通过。第三段残值保留为 0，但四维状态及可靠坐标未交付；其他状态组合未实现。 |
| A05 | 仅 Reader 固定旧包离线回放通过。没有执行 Model 的两入口解释及全部相关 IO 拦截。 |
| A18 | Reader 四个固定输出哈希和旧调用方兼容回归通过。Model 旧 raw_page、单图回执、正式记录及完整降级边界未验证。 |

没有 UI 改动。未执行 1440px/390px 浏览器操作，未访问任何数据库，未作正式业务提交，未作 Model 接纳。平台独立验收未执行，作者测试不替代该验收。

## 影响与执行边界

修改前执行了受影响已有符号的 upstream impact。extract_one 有 9 个直接引用，影响 11 条流程；extract_page_fields 和 attach_contract 同为 CRITICAL，已在修改前报告。其余模板写入和包导出为 LOW。最终 detect_changes 报告 CRITICAL、26 条受影响流程，结果在 gitnexus-detect-changes.json。该工具只统计了 6 个已跟踪修改文件，并因行号偏移列出部分未改函数；新增文件另由 source-verification.json 和 Git 状态清单核对，不能把该工具输出当作完整新增代码审查。

按项目适配由本票实施者单独写入，how 只读助手完成调用链核对。没有启动其他 Slice、PR 或调度。Feature 原步骤、项目替换、实际读取版本和未执行项在 todo.md。完整 v2 架构、字段冻结和独立验收仍待材料门满足后执行。

本轮按 Test Behavior, Not Implementation 原则，通过真实接口结果与固定历史哈希检查用户可观察行为，保留失败而未改成恒通过。未完成的新 v2 功能没有因 71 项既有回归通过而被标成完成。
