# M03A 独立验收

结论：通过本票组汇总草稿范围。固定源码为 4319f1d94897ef9d8fae976bb761c7f8f0925a56。仅使用 mold 既有 Python 环境，没有调用 Reader 当前工作区，没有改动交付源码。

已先读取 68473f13a9aa42eb90a88ffc 与 92d973167ffd6f6f5c7cbedb 的原始报告及证据。22 个交付文件哈希全部匹配。历史离线与数据库回归保持原记录，不作为本轮新执行结果。固定输入清单为空，话题材料索引无图片。本轮明确采用原测试中的人工事实与固定观测回放，不宣称真实识读。

已读取仓库 verify skill、功能清单、批准 Spec 副本和同提交 acceptance.md。通用 full 不覆盖本票组汇总，因此执行本票已登记 API 和浏览器入口，没有以 skill 名称代替验证。

本轮实际执行：

- APP_ENV=test DATABASE_URL=sqlite:// /data1/code/mold-data-webpage-tool/backend/.venv/bin/python -m pytest -q -p no:cacheprovider backend/tests/test_hmi_protocol_library_m03a.py --basetemp "$AP_GRAPH_OUTPUT_DIR/api-tmp" --junitxml "$AP_GRAPH_OUTPUT_DIR/api.xml"。7 passed，见 api.log、api.xml。
- node "$AP_GRAPH_OUTPUT_DIR/build-current.mjs"。成功构建当前源码，见 build-current.log。
- APP_ENV=test DATABASE_URL=sqlite:// PLAYWRIGHT_MODULE="$AP_GRAPH_BROWSER_MODULE" PLAYWRIGHT_CHROMIUM_EXECUTABLE="$AP_GRAPH_BROWSER_EXECUTABLE" TMPDIR=/tmp /data1/code/mold-data-webpage-tool/backend/.venv/bin/python -m pytest -q -p no:cacheprovider backend/tests/test_hmi_protocol_library_m03a_browser.py --basetemp "$AP_GRAPH_OUTPUT_DIR/browser-tmp" --junitxml "$AP_GRAPH_OUTPUT_DIR/browser.xml"。1 passed，见 browser.log、browser.xml。

A08 通过。s/ms 同值合并来源，不同设定值保留冲突，setting 与 actual 分离，actual 不同测量时刻保留。disabled 不进入有效设定，unknown 未自动启用。同名不同目标不合并。见 m03a-a08-api.json、m03a-actual-times.json 和 API 测试断言。

A09 通过固定观测回放。75% 与 150 rpm 无基准时未决，补充 200 rpm 基准后旧预览过期，新预览为等值 150 rpm，双方来源与基准依赖保留。见 m03a-a09-reference.json。

A16 本票部分通过。1440 和 390 视口实际操作来源跳转、原屏 10 改 11、保存、过期提示、重新预览、查看冲突、独立 GET 和重开，再将 11 修订为 10 并重新预览、重开。回读与保存结果一致。四张 m03a-*-conflict/reopen.png 已逐张查看，来源可见，无图标识真实，未发生页面脚本错误或文档横向溢出。未决状态本轮覆盖 API，未单独执行其浏览器补基准流程。冲突裁定与正式确认留给 M03B。

A18 本票部分通过。旧单图回执只读保留，不自动合并，拒绝子图重复写入并保持原 GET。其他用户无权访问组预览。事务故障后 GET 不变，过期 revision 返回 409，客户端注入 values 返回 422，成员变化触发过期。见 m03a-a18-legacy.json 和 api.log。

本轮没有发现已执行场景的业务失败。常规 npm build 初次失败，因为 Vite 在只读源码旁写临时配置。已通过 build-current.mjs 加载原始 vite.config.js，使用现有依赖和当前源码构建，将缓存及产物写本轮目录。此问题未阻断验收，也未修改源配置。保留 build.log。构建大 chunk 提示和 TestClient 弃用警告未影响退出结果。

数据库连接在进程启动前设置为一次性 SQLite，实际 fixture engine 经校验后建表。浏览器服务随机回环端口启动且确认停止，见 m03a-browser-cleanup.json。未写共享数据库、未安装依赖、未创建环境、未运行 Git 历史操作。

未测：实时 OCR、实图准确率和 bbox、正式 Run 提交、PostgreSQL 并发、全项目历史格式矩阵。上述不作为 M03A 通过能力。本票结论也不代表 M03B 或全部路线验收通过。

已核对实施者 todo.md、报告与源码，并读取 poteto-mode、Codex 映射和项目适配规则。check-playbooks.mjs 返回 Every project playbook matches this pstack's playbooks。平台指定独立 tester 已执行当前 API/浏览器和原始证据复核。

修改文件：交付源码无修改。新增文件均在本轮 AP_GRAPH_OUTPUT_DIR，包括 review.md、review.json、source-verification.json、build-current.mjs、日志、JUnit、截图、API/浏览器回读、构建目录及隔离测试临时文件。
