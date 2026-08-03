---
doc_type: HANDOVER
doc_status: ready
next_action: none
plan: null
slice: null
plan_progress: complete
date: 2026-08-03
---

# 065_HANDOVER_20260803_DEMAG多级阶段识别修复与算法改进

## 1. 背景与问题描述

用户在 `mold-data-webpage-tool` (Platform Local HMI 识别试用) 上传了 3 张 DEMAG 德马格注塑机 HMI 屏幕原图：
1. `1785755209396.jpeg` (多级注射曲线页)
2. `1785755259328.jpeg` (多级保压页)
3. `1785755292142.jpeg` (多级背压/预塑页)

此前由于界面排版错位、页面子变体字典缺失以及强制等长校验，导致后面两张图片出现 `STAGE_REJECT` 或数组字段被归零/错配的问题。

---

## 2. 根因分析与 Schema 解耦方案 (Empirical Root Cause & Schema Decoupling)

通过调取实测 OCR Token 像素与归一化坐标分析，DEMAG 的 3 种多段界面具有完全不同的语义与排版结构：

### ① `1785755209396.jpeg` — `multi_stage_injection` (多级注射)
- **排版结构**：错行排版。第 2 行 `速度` 对应右侧阶段压力数组 `[0.0, 25.0, 75.0]`；第 3 行 `位置` 对应右侧阶段速度数组 `[0.0, 22.5, 45.0]`。
- **解耦 Schema**：
  - `pressure_limit_bar`: `65.0`
  - `first_velocity_mms`: `12.0`
  - `first_position_mm`: `17.5`
  - `stage_pressure_bar`: `[0.0, 25.0, 75.0]`
  - `stage_velocity_mms`: `[0.0, 22.5, 45.0]`

### ② `1785755259328.jpeg` — `multi_stage_holding` (多级保压)
- **排版结构**：同行排版。第 1 行 `速度[mms]` (保压速度 limit `12.0`)；第 2 行 `压力[bar]` (阶段保压压力数组 `[0.0, 55.0, 60.0, 65.0]`)；第 3 行 `时间]` (阶段保压时间数组 `[0.0, 1.0, 2.0]`)。
- **解耦 Schema**：
  - `holding_velocity_mms`: `12.0`
  - `stage_holding_pressure_bar`: `[0.0, 55.0, 60.0, 65.0]`
  - `stage_holding_time_s`: `[0.0, 1.0, 2.0]`
  - 自动提供向后兼容字段 `stage_pressure_bar` 与 `stage_velocity_mms`。

### ③ `1785755292142.jpeg` — `multi_stage_back_pressure` (多级背压/预塑)
- **排版结构**：同行排版。第 1 行 `背压[bar]` (阶段背压 `[3.0, 3.0]`)；第 2 行 `螺杆转速` (阶段转速 `[40.0]`)；第 3 行 `位置` (`4.4`)；第 4 行 `速度` (`80.0`)。
- **解耦 Schema**：
  - `stage_back_pressure_bar`: `[3.0, 3.0]`
  - `stage_plasticizing_speed_rpm`: `[40.0]`
  - `first_velocity_mms`: `80.0`
  - `first_position_mm`: `4.4`
  - 自动提供向后兼容字段 `stage_pressure_bar` 与 `stage_velocity_mms`。

---

## 3. 代码修改内容

### 1) [`scripts/extract_families/demag_injection.py`](file:///data1/code/hmi_data_reader/scripts/extract_families/demag_injection.py)
- 实现多页态子变体（`multi_stage_injection` / `multi_stage_holding` / `multi_stage_back_pressure`）自动检测。
- 增加专属 Schema 字典解耦映射（如 `stage_holding_pressure_bar`、`stage_holding_time_s`、`stage_back_pressure_bar`、`stage_plasticizing_speed_rpm`）。
- 保持通用基础字段向后兼容，确保旧版契约不中断。

### 2) [`tests/test_demag_injection.py`](file:///data1/code/hmi_data_reader/tests/test_demag_injection.py)
- 更新单元测试用例，覆盖多子变体 Schema 输出与兼容性。

---

## 4. 验证结果

1. **单元测试**：
   - `pytest tests/test_demag_injection.py` **3 passed**。
   - `mold-data-webpage-tool/backend`: `pytest tests/test_hmi_recognition.py` **16 passed**。
2. **常驻 GPU HTTP 服务实测** (`curl -F "file=@..." http://127.0.0.1:8765/recognize`)：
   - **`1785755209396.jpeg`**：`status: ok`, `variant: multi_stage_injection`, `stage_pressure_bar: [0.0, 25.0, 75.0]`, `stage_velocity_mms: [0.0, 22.5, 45.0]`。
   - **`1785755259328.jpeg`**：`status: ok`, `variant: multi_stage_holding`, `stage_holding_pressure_bar: [0.0, 55.0, 60.0, 65.0]`, `stage_holding_time_s: [0.0, 1.0, 2.0]`, `holding_velocity_mms: 12.0`。
   - **`1785755292142.jpeg`**：`status: ok`, `variant: multi_stage_back_pressure`, `stage_back_pressure_bar: [3.0, 3.0]`, `stage_plasticizing_speed_rpm: [40.0]`, `first_velocity_mms: 80.0`, `first_position_mm: 4.4`。
3. **服务部署**：
   - 执行 `systemctl --user restart hmi-gpu-service.service` 完成最新代码载入与显存预热，就绪状态 OK。
