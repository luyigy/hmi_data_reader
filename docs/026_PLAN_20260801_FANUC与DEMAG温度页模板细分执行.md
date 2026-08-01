---
doc_type: PLAN
doc_status: paused
next_action: none
plan_kind: phase
date: 2026-08-01
basis:
  - docs/013_PLAN_20260730_主力家族温度页模板.md
  - docs/025_HANDOVER_20260801_S2伯乐20图验收PASS与013S3收口.md
  - output/s4_progress.json
objective: "以细分小步完成 FANUC/DEMAG 温度页模板与真值集：每 turn 只做一个可验证小步并即时 checkpoint，消除 1800s completion gate 超时风险；不授予生产自动入库权限"
first_slice: S1
scope_in:
  - 已盘点候选池 580 条/3 台（发那科 Z032=FANUC、德马格 Z002/Z005=DEMAG）的 18 目标 + 12 候补
  - 下载去重、VLM 预标注、飞书核验表、真值落盘、双家族模板校准、提取器扩展、18 图链路验收
  - extract_fields.py 超阻断线的模块拆分（023 留下的"另行立项"项，本计划正式立项）
scope_out:
  - 3 台 UNKNOWN 发那科机台（Z027/Z035/Z036）及此前 17 台伯乐、9 台日精 UNKNOWN 裁定
  - VLM 参与提取链路（仅用于预标注草稿，与 S2/S3 同口径）
  - 生产真实自动入库、飞书回填、服务重启
---

> **批准与自动接力**（2026-08-01）：用户批准本 PLAN 并开启自动模式——全部切片按 `docs/027_ROADMAP_20260801_全局路线图与自动接力协议.md` §3 连续执行，含 30 条下载与 VLM 草稿预授权；真值确认降级为自动整批接受（`visual_skim_acceptance` 降级说明 + 用户事后否决权）。硬约束不变：不生产入库、不飞书回填、不重启服务。

# FANUC / DEMAG 温度页模板细分执行计划

## 1. 为什么这样切：S3 卡点的实证分析

对 2026-07-31 S3 伯乐全程的文件级时间戳复盘，耗时分布如下：

| 环节 | 证据 | 耗时 | 是否卡点 |
|---|---|---:|---|
| 下载 31 条附件 | docs/samples_bole/ 全部齐于 19:56 | 分钟级 | **否** |
| VLM 预标注 20 图 | output/bole_drafts/ 20:43 → 21:40 | **≈57 分钟**（串行 ~3 min/图） | **是，最大单块** |
| 全链路 20 图（去重→门禁→矫正→两路 OCR→分类） | output/bole_calib/ 22:01:xx → 22:04:17 | **≈2.5 分钟** | **否（比预期快两个量级）** |
| 模板校准迭代（含重提取） | rectified 22:04 → extracted 22:48 | ≈44 分钟 | 是，第二块 |
| Kimi 沙箱启动卡死 | docs/017 REPORT：`.venv-s1` 未忽略 → git status stdout 1.24MB 溢出 | 启动级卡死 | 是（已修） |
| 单 turn 塞完整切片 | docs/013 §5：触发 1800s completion gate 超时 | 整片报废 | 是（本计划根除此模式） |

结论：**下载和 OCR 都不是卡点**；卡点是 ① VLM 串行预标注、② 校准迭代、③ 单 turn 负载过大撞 1800s gate。本计划的对策是把 VLM 和校准按机台/家族拆小批，每 turn 一个小步，长任务一律后台跑。

## 2. 超时防护硬规则（全计划适用）

1. 每 turn 只完成一个可验证小步，完成即把 checkpoint 写入 `output/s4_progress.json`（沿用 013 §5 接力方式），中断后续跑不重做。
2. VLM 预标注、OCR 重跑等 >5 分钟的任务一律 `run_in_background` 执行，前台 turn 只做派发与验收，不阻塞等待。
3. 禁止单 turn 跨切片；任一小步超预算即停止并记录，不硬撑到 gate 杀。

## 3. 细分切片

### S1：下载与去重（前提：用户批准候选清单；预计分钟级）

1. 按 `output/fanuc_demag_candidates.json` 下载 18 目标 + 12 候补到 `docs/samples_fanuc_demag/`。
2. SHA-256 内容级去重：池内重复、与本地校准/遗留图重复，按候补固定顺序（rank 升序）替换，不人工挑图。
3. 落 `output/fanuc_demag_sample_manifest.json`，checkpoint。

### S2：VLM 预标注（拆 3 小批，单批 ≈20 分钟，后台跑）

- 按机台分 3 批：Z032×6、Z002×6、Z005×6，只对 18 张目标图出草稿（候补同 S3 惯例不出草稿）。
- 每批独立后台任务，落盘 `output/fanuc_demag_drafts/` 即 checkpoint；模糊字段一律 null 不猜数（S3 口径）。
- 三批不必同 turn；每 turn 最多派发一批并验收上一批。

### S3：飞书核验表（单 turn）

建「FANUC/DEMAG温度页字段核验」表，预填 18 行 + 原图，落 `output/fanuc_demag_verify_table_records.json`，交用户整批确认（人工门，不占 turn）。

### S4：真值落盘（单 turn）

用户确认后转 `ground_truth/fanuc_demag_temperature/` ×18；报警态图 `allow_auto_import=false`（沿用 S3 rank16 先例与 023 拒识口径）。

### S5：FANUC 模板校准（单 turn）

6 图两路 OCR 实测锚点（全量 20 图 OCR 实测仅 ~2.5 分钟，余量充足）→ `templates/fanuc.temperature.json` + 关键词全库碰撞检查。

### S6：DEMAG 模板校准（单 turn）

同法 → `templates/demag.temperature.json` + 碰撞检查。

### S7：提取器扩展（先拆后加，1~2 turn）

`scripts/extract_fields.py` 已 1158 行，超合同 1000 行阻断线。先把 KEBA/B_AND_R 提取器拆到 `scripts/extract_families/` 同构模块（净行为不变，ZizES/TACT/伯乐 21+20+6 图提取零 diff 为验收），再按同构加 FANUC/DEMAG 分支。拆分即 023 遗留"另行立项"项的正式立项。

### S8：18 图链路验收（单 turn，~5 分钟）

去重→质量门禁→矫正→OCR→控制器/页面分类→字段提取→真值比对跑一次；六项指标 + rejection_accuracy（023 口径），硬门槛 numeric ≥0.95 / error =0 / rejection =1（空分母 N/A 不宣称 PASS）。看过结果后冻结，不追加调参轮次。

### S9：HANDOVER 与 013 S4 收口（单 turn）

合同合规 HANDOVER，记录 PASS/FAIL、残留与边界，回到 013 S4 收口；不自动启动新家族。

## 4. 风险与控制

| 风险 | 控制 |
|---|---|
| VLM 批撞 1800s gate | 单批 6 图 ≈20 min + 后台运行 + 分批跨 turn |
| FANUC/DEMAG 页结构与 KEBA/B&R 差异大，模板一轮不达标 | S8 只跑一次；FAIL 则如实报告交回审批，不在本计划内追加轮次 |
| 提取器拆分引入回归 | 拆分后全部既有家族提取零 diff 才允许加新分支 |
| 校准集=验收集过拟合 | 同 S2/S3 声明：只声明链路可运行，不宣称泛化 |
| DEMAG 家族证据为间接证据（NC 风格） | 真值阶段用户确认时复核；报告保留降级说明 |

## 5. 交付与停止规则

- 每切片：对应产物 + checkpoint；S9：最终报告 + HANDOVER。
- 任一切片完成即停止；不下载未批准附件，不更新飞书（除 S3 核验表），不重启服务，不执行生产写入。

## 6. S8 验收 FAIL 与审批等待（2026-08-01 修订）

- **S8 一次验收完成**：numeric 0.8747（门 0.95）FAIL、error 0.0（门 =0）PASS、rejection N/A（无负样本分母）；分类双 1.0，完整率 0.8993，既有家族零 diff。按 §3 规则不追加调参轮次。
- **残差分析与路径**：见 `docs/028_HANDOVER_20260801_S8验收FAIL_残差分析与路径交审批.md`——①rank07 真值口径、②OCR 层手段、③接受 FAIL 挂起，交用户审批。
- 013 S4 不收口，本 PLAN 停于 await_acceptance。

## 7. 用户裁定收尾（2026-08-01）

- **路径③挂起**：用户 2026-08-01 裁定接受现状挂起——FANUC/DEMAG 链路与真值保留（分类 1.0、error=0、rejection 1/1），不再投入 OCR 层攻关；后续需要时另立项。
- **路径①已执行**：rank07 真值改判 allow_auto_import=false（拒识样本），rejection 门生效 1/1 PASS，numeric 0.8747→0.9093。
- **段序裁定已执行**：DEMAG 段序=屏幕序 喷嘴1/区3/区2/区1，真值×12/提取器/模板/飞书已同步。
- 最终态：numeric 0.9093（门 0.95 未达，用户知悉接受）、error 0.0、rejection 1.0、分类双 1.0。
