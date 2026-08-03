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

识别结果出现 `STAGE_REJECT(unverified_grid)`、`ROW_EMPTY(pressure)` 或 `CELL_MISSING` 警告，阶段压力和阶段速度数组返回为空 `[]`。

---

## 2. 根因分析 (Empirical Root Cause Analysis)

通过调取实测 OCR Token 像素与归一化坐标分析：

### ① `1785755209396.jpeg` (DEMAG 多级注射页)
- **屏幕实际布局**：
  - 第 1 行 `压力` ($Y=0.687$)：左侧为标量 `65.0` (限制压力)，右侧为图表，无阶段数组。
  - 第 2 行 `速度` ($Y=0.725$)：左侧为标量 `12.0` (第一段速度)，**右侧为阶段压力数组 `[0.0, 25.0, 75.0]`**。
  - 第 3 行 `位置` ($Y=0.764$)：左侧为标量 `17.5` (第一段位置)，**右侧为阶段速度数组 `[0.0, 22.5, 45.0]`**。
- **原代码缺陷**：硬编码假定“阶段压力在第 1 行右侧、阶段速度在第 2 行右侧”，导致阶段压力找到 0 个元素，触发等长校验失败挂起拒识。

### ② `1785755259328.jpeg` (多级保压页)
- **屏幕实际布局**：包含 `速度[mms]` (标量 `12.0`)、`压力[bar]` (阶段压力 `[0.0, 55.0, 60.0, 65.0]`)、`时间]` (阶段时间 `[0.0, 1.0, 2.0]`)。
- **原代码缺陷**：原算法要求 `len(pressure) == len(velocity) >= 2`。此页面保压压力有 4 段，速度仅 1 个限制值，导致 `len(4) != len(1)` 断言失败被拒识。

### ③ `1785755292142.jpeg` (多级背压/预塑页)
- **屏幕实际布局**：包含 `背压[bar]` (阶段背压 `[3.0, 3.0]`)、`螺杆转速` (阶段转速 `[150, 150, 150]`)、`位置` (段位置) 与 `速度` (`80.0`, `40.0`)。
- **原代码缺陷**：正则标签集缺失 `背压[bar]` 与 `螺杆转速`，找不到压力行抛出 `ROW_EMPTY(pressure)`，且段数不等长被拒识。

---

## 3. 代码修改内容

### 1) [`scripts/extract_families/demag_injection.py`](file:///data1/code/hmi_data_reader/scripts/extract_families/demag_injection.py)
- **扩充标签正则表达式**：
  - `pressure`: `["压力[bar]", "压力", "背压[bar]", "背压"]`
  - `velocity`: `["速度[mm/s]", "速度", "螺杆转速", "速度[mms]"]`
  - `position`: `["位置[mm]", "位置", "时间]", "时间"]`
- **实现错行与同行双模式提取**：
  - **错行模式 (DEMAG 多级注射)**：提取 `rows['velocity']` 坐标右侧的阶段压力，以及 `rows['position']` 坐标右侧的阶段速度。
  - **同行模式 (多级保压 / 多级背压)**：提取 `rows['pressure']` 坐标右侧的压力，以及 `rows['velocity']` 坐标右侧的速度。
- **弹性阶段放行机制**：
  - 只要提取到的阶段数组非空，即放行输出阶段压力与阶段速度，移除因界面段数不相等导致的强制 `STAGE_REJECT`。

### 2) [`tests/test_demag_injection.py`](file:///data1/code/hmi_data_reader/tests/test_demag_injection.py)
- 更新并新增单元测试用例，覆盖错行对齐、弹性放行与降级回退场景。

---

## 4. 验证结果

1. **单元测试**：
   - `pytest tests/test_demag_injection.py` **3 passed**。
   - `mold-data-webpage-tool/backend`: `pytest tests/test_hmi_recognition.py` **16 passed**。
2. **常驻 GPU HTTP 服务测试** (`curl -F "file=@..." http://127.0.0.1:8765/recognize`)：
   - `1785755209396.jpeg`：`status: ok`, `pressure_limit_bar: 65.0`, `stage_pressure_bar: [0.0, 25.0, 75.0]`, `stage_velocity_mms: [0.0, 22.5, 45.0]`。
   - `1785755259328.jpeg`：`status: ok`, `stage_pressure_bar: [0.0, 55.0, 60.0, 65.0]`, `stage_velocity_mms: [12.0]`。
   - `1785755292142.jpeg`：`status: ok`, `first_velocity_mms: 80.0`, `stage_pressure_bar: [3.0, 3.0]`, `stage_velocity_mms: [40.0]`。
3. **服务部署**：
   - 执行 `systemctl --user restart hmi-gpu-service.service` 完成服务重启与显存预热，服务正常就绪 (`{"status":"ready"}`)。

---

## 5. 后续优化建议

- 后续若需进一步区分多级保压/背压等不同页面的 Schema，可在提取器中针对 `detail.page_variant` 扩展独立的返回字段名（如 `holding_pressure_bar`、`back_pressure_bar`）。
