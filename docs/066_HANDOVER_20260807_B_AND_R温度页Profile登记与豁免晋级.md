---
doc_type: HANDOVER
doc_status: ready
next_action: none
plan: null
slice: null
plan_progress: complete
date: 2026-08-07
---

# 066_HANDOVER_20260807_B_AND_R温度页Profile登记与豁免晋级

## 1. 背景

科学试模温度设置页接入 HMI 照片识别预填（主仓第一期）。实测 `ground_truth/bole_BR`
浅色 UI（无 NZ 列、#1~#5 五温区）温度照片：现有 `b_and_r.temperature.json` 模板经
模板指纹兜底路由即可正确提取全部 26 个值（设定/实际/高低温偏差/加热输出/保温），
无需新写识别代码。但被两个非识别问题挡住：

1. `classify_ui` 关键词未命中浅色 UI → `ui_family_confidence=0.0` → `profile_confidence=0.0`，
   无法过 verified ≥0.9 门；
2. `b_and_r.temperature.fixed` 未在 profiles.json 登记（status unknown）；
3. 契约 `entity.columns` 写死 DEMAG 列序 `[喷嘴1,区3,区2,区1]`，与 B&R 6 列 `[NZ,#1~#5]` 不符。

## 2. 变更内容

### 1) 路由证据置信度兜底（`scripts/contract.py`）

- 新增 `_routed_confidence()`：仅 service 路径（classification 非 None）且分类器
  置信度为 0/缺失时启用；家族经 record 聚合/机台先验（0.95）或模板指纹
  `family_detect_groups`（0.9）确认、页面经模板锚点或分类器确认时，取两者最小值。
  离线 extract 路径（classification=None）保持既有默认口径 0.7，历史回归产物零 diff。
- `per_image_classify` 与分类器同源，不在兜底范围（避免自证）。

### 2) 契约 v2.6.0（`contracts/field_catalog.json`）

- 5 个料筒温区数组字段（`barrel_temperature_set_c`/`barrel_temperature_current_c`/
  `high_deviation_c`/`low_deviation_c`/`control_percent`）新增 `entity_overrides`：
  `b_and_r.temperature.fixed` 列序 `[NZ,#1,#2,#3,#4,#5]`；`attach_contract` 按
  profile_id 合并覆盖 entity（拷贝合并，不污染 lru_cache 目录对象）。
- 列语义：NZ=射嘴区；**无 NZ 列的浅色 UI 变体 NZ 位输出 null，此时 #1=射嘴**
  （用户 2026-08-07 裁定），#2~#5=料筒 1~4 区。
- minor bump（2.5.1 → 2.6.0），向后兼容，主仓 pin 区间 [1.0.0, 3.0.0) 内零调整。

### 3) Profile 登记与所有者豁免晋级（`contracts/profiles.json`）

- 登记 `b_and_r.temperature.fixed` 并豁免晋级 **verified**（沿用
  `demag.injection_metering.multi_stage_holding` 先例格式）。
- 证据：7 份用户核验真值（bole_Z046×6 + bole_Z004，模板校准样本）；bole_BR 浅色
  变体实测提取全对；#1=射嘴经用户裁定；路由证据置信度兜底就位。
- 偏差披露：无独立 holdout（浅色变体仅 1 张温度页照片，未走契约真值报告门禁）；
  Web 映射经单测覆盖，未做 UI 点击级实测。风险由所有者接受；反馈连续 2 次字段
  不符自动降级 quarantined。

## 3. 验证

- 服务重启后实测 bole_BR 温度照片：`profile_id=b_and_r.temperature.fixed`、
  `status=verified`、`profile_confidence=0.9`、`contract_version=2.6.0`、
  `field_meta.columns=[NZ,#1..#5]`，字段值与照片一致。
- `pytest tests/`：80 passed；`test_demag_stage_enabled` 6 个失败与
  `test_ocr_variants` 收集错误（系统 Python 缺 cv2）经 stash 对照均为预置问题，
  与本次改动无关。

## 4. 遗留事项

- bole_BR 温度页 holdout 不足（1/5），后续补拍后应走契约真值报告复核 verified。
- `bole_est`（EST 青绿 UI）温度设定页仍无模板（2 张照片已盘点），EST 温度模板
  为下一迭代；EST3"温度"照片实为主画面温度条，不在支持范围。
- 主仓侧配套（契约快照、兼容性、sciHmiPrefill 映射）见主仓 049 HANDOVER。
