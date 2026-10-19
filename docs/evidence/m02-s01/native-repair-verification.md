# M02 冻结绑定 OCR 候选修复

本轮修复 QA 指出的范围内故障。已完成实现与本票实测，等待平台受控提交和独立验收。本报告不代替独立验收。

## 结果

必跑入口 16 passed，0 skipped。真实 CPU OCR 两轮均生成 17 个 Model 候选，holding.time.1 = 1.0 s、holding.time.2 = 5.0 s，value_role=setting，source=ocr，h1/h2 保持 unknown。截图检查与独立 GET 证明 BOLE/B_AND_R 的 0.1.2 绑定可以在 1440/390 视口保存和重开。两项浏览器用例通过。

## 根因与修改

check_receipt 原先验证了冻结页面，但 recognize 丢弃返回页面，extract_ocr_fields 再读取 profiles_for_page 的默认 current=0.1.1。提取时又把控制器 B_AND_R 与机台品牌 BOLE 比较，从而清空业务候选。

现在保留 selected_page，按 acceptance_id 读取 AcceptanceRepository.version 的审核 candidate。用完整 accepted_page 核对哈希、身份和接纳内容，再核对 candidate 的 page_id/package_version/controller/rule_version。提取使用这个 PageProfile，并以冻结 page.brand 校验机台品牌。未绑定调用仍走原来的三参路径。

冻结专用别名回归创建一个只有接纳版本包含的“冻结专用时间1”，通过实际 recognize API 生成 holding.time.1 并独立 GET。修改机台品牌后 saved OCR reuse 仍生成品牌不符提示并拒绝字段候选。正式包、旧 0.1.1 字节及 current 指针均未改动。

测试夹具默认控制器改为与原 DEMAG 解释一致，避免把测试合成控制器误作可解释身份。浏览器共存测试显式保留 TEST-CONTROL-A。合成身份只用于受控测试。

## 命令与证据

从本任务 worktree 执行，使用已有环境，无新增虚拟环境或依赖。

- `/data1/code/mold-data-webpage-tool/backend/.venv/bin/python -m pytest -q backend/tests/test_hmi_protocol_library_m02.py`。修复前新增候选断言的实际失败为 `1 failed, 13 passed`，见 repro.log。最终 `16 passed`，见 ticket-behavior-final.log。首次修复检查 `15 passed`，见 ticket-behavior.log。
- `npm run build -- --outDir "$AP_GRAPH_OUTPUT_DIR/frontend-dist"`，在 frontend 目录执行，成功，见 frontend-build.log。
- `PLAYWRIGHT_MODULE="$PWD/scratch/platform-browser-q7fq0n3k/node_modules/playwright" PLAYWRIGHT_CHROMIUM_EXECUTABLE="$PWD/scratch/platform-browser-q7fq0n3k/chrome/chrome" /data1/code/mold-data-webpage-tool/backend/.venv/bin/python -m pytest -q backend/tests/test_hmi_protocol_library_m02_browser.py`。`2 passed`，见 browser.log。截图和 roundtrip 见 formal-browser/ 及本目录同名 m02-binding 文件。已目视检查正式包桌面与手机重开截图，版本及绑定可见。
- `/data1/code/mold-data-webpage-tool/backend/.venv/bin/python -m pytest -q backend/tests/test_hmi_ocr_semantics.py backend/tests/test_hmi_capture_recognition.py backend/tests/test_hmi_fanuc_reader_observations.py`。补充旧链路检查 `10 passed, 1 failed`。失败原因是旧 enum 绑定测试要求额外仓 scripts/workbench_protocol.py，本任务批准输入中没有该文件，见 legacy-regression.log。未访问未授权第三仓。
- `/data1/code/mold-data-webpage-tool/backend/.venv/bin/python -m pytest -q backend/tests/test_hmi_ocr_semantics.py backend/tests/test_hmi_fanuc_reader_observations.py`。可运行的旧 OCR 专项 `7 passed`，见 legacy-ocr.log。
- `git diff --check` 通过。节点 hello，Git 元数据只读，没有 add/commit/merge。

## 实际验收范围

API 与 GET。A06 同控制器/版式共存、多物理页面、两次照片上传自动选页。A07 兼容拒绝原因及错绑无 fallback。A14 升级/停用/回滚、冻结解释与历史不变。A15 普通工程师和管理员权限、跨用户拒绝、失败事务、旧 revision。以上由票据 API 行为测试运行，相关 JSON 已留存。

浏览器。A16 在 M02 绑定范围内执行品牌/控制器选择、确认、保存、独立 GET、1440/390 重开。没有把绑定 UI 检查宣传为其他票的冲突仲裁、正式 Run 写入或全站验收。

实时识读。使用固定 Reader cd92faeb2cfb86486fc9b65d2053e50a31fede2f 的平台 sourcePath 及对应既有 Python 环境。模型文件由固定输入归档 manifest 校验。在本轮目录启动私有 Reader，HTTP 调用真实 CPU OCR，两轮原图识读及错误控制器回执，finally 停止进程。没有 VLM、共享服务或商业模型调用。见 m02-formal-live-chain.json 与 m02-reader-*/reader.log、cleanup.json。

数据库。DATABASE_URL 在导入 app.db 前注入 sqlite://，conftest 检查实际 engine.url，fixture 仅在隔离内存 SQLite 建表。未连接 PostgreSQL、未触碰共享库。迁移测试仅在单独内存 SQLite 检查增量迁移。

## 固定身份与来源

候选基线 `e34d0e3ecf266909e1c72c2e737c713523e7e304`。Reader 固定输入清单 ddf51c854bff0f2bc80556c164c663ba5a6b1a5f34d2a6f76416471df084115c。正式包 `b_and_r.injection_holding.multi_stage_position_time@0.1.2`，包 canonical SHA256 `ac31908a258b3aafb0a696fcf7327b11b4b34043254bb8cc5e49ac07c28487ac`，本轮 acceptance_id `35d165eb-9bdd-4e65-a24a-79d2c90c8306`。图像 SHA256 `ab8c9bcb7e06bab421f6c4d4dba2eae84acea6ebeea2085b56311db9b9e0e9c2`。两轮 GET 均保存完全相同的页面、包与接纳身份，接纳导出独立 GET 与 manifest 一致。

## 边界与待办

平台独立验收和受控提交待平台执行，实施者 helper 不计作独立业务验收。本轮保留旧证据并新增独立报告。

补充旧 enum 桥接测试缺少旧工作台源码，未标为通过。这不阻塞已执行的本票必跑入口或当前 OCR 修复。

管理员旧 remap/bind 路由未修改、未作本轮行为验收。只读 helper 提醒 remap 仍存在读取 current 的历史路径，需要单独判断适用边界；本轮按批准要求修复 recognize 及其 saved reuse，不扩大为旧管理接口重构。没有把此轮结果宣称为这些路径的冻结版本证明。

## 改动文件

- `backend/app/hmi_mapping/capture_recognition.py`
- `backend/app/hmi_mapping/ocr_semantics.py`
- `backend/app/machines/protocol_service.py`
- `backend/tests/test_hmi_protocol_library_m02.py`
- `backend/tests/test_hmi_protocol_library_m02_browser.py`
- `backend/tests/test_hmi_protocol_library_m02_publication.py`
