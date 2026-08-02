---
doc_type: HANDOVER
doc_status: ready
next_action: none
plan: null
slice: null
plan_progress: complete
date: 2026-08-02
---

# 064_HANDOVER_20260802 飞书互动卡片与 Web Console 工具交接文档

**生成时间**：2026-08-02  
**交接主体**：HMI 智能识别助手 · 飞书互动卡片工具与 Web Console (`scripts/feishu_card_assistant.py`)  

---

## 1. 一句话功能概述

新增 `scripts/feishu_card_assistant.py` 工具，实现了 **HMI 屏幕单图端到端识别 -> 飞书 Interactive Card (Schema v2) 动态渲染 -> 终端/Web 实时交互控制台 -> 飞书多维表格 (Bitable) 一键同步** 的完整能力闭环。

---

## 2. 核心架构与处理流水线

脚本集成了项目底层完整的视觉识别与结构化提取能力，整体流水线如下：

```
+------------------+     +--------------------+     +--------------------+
|  HMI 屏幕原始图片 | --> | 屏幕质量门禁 assess | --> | 图像透视矫正 rectify |
+------------------+     +--------------------+     +--------------------+
                                                               |
+------------------+     +--------------------+                v
| 结构化字段提取    | <-- | 家族与页面分类     | <-- | PaddleOCR 区域文本 |
| extract_fields   |     | find_ui/find_page  |     +--------------------+
+------------------+     +--------------------+
         |
         +-------------------------------------------------+
         |                                                 |
         v                                                 v
+------------------+     +--------------------+     +--------------------+
| 飞书互动卡片 Schema|     | Web Preview Console|     | 飞书多维表格同步   |
| (Schema v2 JSON) |     | (HTTP :8765 服务)   |     | (lark-cli sync)    |
+------------------+     +--------------------+     +--------------------+
```

---

## 3. 主要组件与功能特性

### 3.1 单图全流程识别流水线 (`process_hmi_image`)
- **质量检测**：调用 `quality.assess` 进行绿色/黄/红分级与清晰度打分。
- **透视矫正**：调用 `rectify.rectify` 进行倾斜与透视变换裁切。
- **OCR 识别**：环境隔离调用 `PaddleOCR` 获取倾斜框与文本。
- **家族/页面判定**：支持 10+ 控制器家族（B_AND_R, KEBA, TACT, FANUC, DEMAG, ZizES, KAIMING, EST, TRD6, ARBURG）与页面类型（炮筒温度、射出保压/计量、成型监控、波形图、热流道、模温机等）路由。
- **模板结构化提取**：自动匹配 `templates/*.json` 规范提取多段表格或键值对数据。

### 3.2 飞书消息卡片渲染器 (`build_feishu_card`)
- **动态状态 Header**：
  - `OK` (成功)：绿色 Header，带 `✅ 识别成功` 标记。
  - `REVIEW` (待人工核验)：橙色 Header，带 `⚠️ 需要人工核验` 标记。
  - `REJECT` (拒识/异常)：红色 Header，带 `❌ 识别匹配失败` 标记。
- **结构化 Markdown 表格**：
  - **温度页**：渲染为 `[温区 | 设定温度(℃) | 实际温度(℃)]` 对照表。
  - **射出保压页**：渲染为 `[阶段 | 位置(mm) | 速度(%) | 压力(bar)]` 及 VP 切换/保压段明细。
- **交互动作按钮 (Action Block)**：
  - `[📷 继续拍照上传]`
  - `[📥 存入多维表格]`
  - `[🔍 查看矫正图]`

### 3.3 Web Preview Console & Webhook 服务 (`start_server`, `HMIRequestHandler`)
- 基于 Python 标准库 `http.server` 搭建轻量 Web 服务（缺省端口 `8765`）。
- 提供拖拽/本地选择图片预览及实时 Live Card 渲染 UI。
- 提供 `/api/recognize` 端点处理图片上传与识别请求。
- 提供 `/webhook` 端点用于对接飞书开放平台机器人回调。

### 3.4 飞书多维表格 (Bitable) 同步 (`sync_to_bitable`)
- 调用系统 `lark-cli base +record-create`，将品牌、位置编号、时间戳及提取数据 JSON 自动打入飞书 Base 多维表格（默认 Base Token: `Vz2QbZ0lkagmVJsrMZ7cQwbSnZc`，Table ID: `tbl1ACm7qNrrKsPc`）。

### 3.5 终端 ASCII 可视化输出 (`print_terminal_card`)
- 在命令行中直观打印格式化 Card 边界、识别状态、机台/页面元信息及提取字段明细表。

---

## 4. CLI 使用命令指南

```bash
# 1. 识别单张图片，并在终端显示格式化卡片与生成卡片 JSON 文件
.venv/bin/python3 scripts/feishu_card_assistant.py --image <图片路径>

# 2. 识别图片并自动同步结果至飞书多维表格
.venv/bin/python3 scripts/feishu_card_assistant.py --image <图片路径> --sync-bitable

# 3. 识别图片并将互动卡片直接发送给指定飞书用户 (OpenID) 或群聊 (ChatID)
.venv/bin/python3 scripts/feishu_card_assistant.py --image <图片路径> --send --user-id <OpenID>
.venv/bin/python3 scripts/feishu_card_assistant.py --image <图片路径> --send --chat-id <ChatID>

# 4. 启动 Web Console & Webhook 接收服务 (浏览器访问 http://localhost:8765)
.venv/bin/python3 scripts/feishu_card_assistant.py --serve --port 8765
```

---

## 5. 实测验证数据

以 `docs/samples_mt_z036/` 及 `docs/samples_inj_z050/` 照片实测：
- **运行耗时**：端到端平均 `3.8 秒`
- **卡片产物**：输出存储至 `output/<image_stem>.feishu_card.json`
- **多维表格接入**：通过 `lark-cli` 成功上报结构化记录

---

## 6. 修改与新增文件清单

| 文件路径 | 状态 | 变动说明 |
| :--- | :--- | :--- |
| `scripts/feishu_card_assistant.py` | **新增** | 飞书互动卡片与 Web Console 核心脚本 |
| `docs/samples_mt_z036/` | **新增** | 用于飞书卡片实测的 6 张测试图片样本 |
| `.gitignore` | **修改** | 过滤测试卡片 JSON 等中间产物 |
| `docs/064_HANDOVER_20260802_飞书互动卡片与WebConsole工具.md` | **新增** | 本交接文档 |
| `docs/000_INDEX.md` | **修改** | 注册 064 交接文档索引 |
