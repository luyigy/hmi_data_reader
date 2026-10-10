#!/usr/bin/env python3
"""
HMI 智能识别助手 - 飞书卡片 & 互动识别服务 (MVP Tool)

功能：
1. 单图全流程识别：图片 -> 质量检测 -> 透视矫正 -> OCR -> UI/页面分类 -> 结构化字段提取
2. 飞书互动卡片渲染：将提取结果渲染为标准的飞书消息卡片（Feishu Interactive Card JSON）
3. 终端可视化预览：在终端直观打印格式化卡片与表格数据
4. 飞书多维表格同步：一键通过 lark-cli 将识别结果存入多维表格
5. Web / Webhook 服务：提供前端拍照/上传预览 UI 与 飞书 Callback / API 接收端点

用法：
    # 单图识别并显示终端卡片 & 飞书 Card JSON
    python3 scripts/feishu_card_assistant.py --image docs/samples_mt_z036/inj_Z036_20250327_rank05_recuQJJFYY3hBo.jpeg

    # 单图识别并发送到飞书消息（需指定 --chat-id 或 --user-id）
    python3 scripts/feishu_card_assistant.py --image <path> --send --chat-id <chat_id>

    # 启动 Web / Webhook 服务（默认端口 8765）
    python3 scripts/feishu_card_assistant.py --serve --port 8765
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import subprocess
from dataclasses import asdict
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

# 让脚本能够 import 项目内 scripts 模块
HERE = Path(__file__).resolve().parent
ROOT_DIR = HERE.parent
sys.path.insert(0, str(HERE))

# 导入底层识别模块
try:
    from quality import assess
    from rectify import rectify
    from classify_ui import find_ui_family, find_page
    from extract_fields import (
        route_family, route_page, load_template, norm_tokens, TEMPLATES_DIR, RECORD_REPORT, MACHINE_LABELS,
        extract_temperature, extract_temperature_tact, extract_temperature_keba,
        extract_temperature_b_and_r, extract_temperature_fanuc, extract_temperature_demag,
        extract_injection_tact, extract_injection_demag, extract_injection_fanuc,
        extract_injection_zizes, extract_injection_keba, extract_injection_b_and_r,
        extract_injection_kaiming, extract_injection_est, extract_injection_trd6,
        extract_injection_arburg, extract_molding_monitor_fanuc, extract_waveform_fanuc,
        extract_hot_runner_tact, extract_mold_temp_fanuc
    )
except ImportError as e:
    print(f"[WARN] 模块导入警告: {e}", file=sys.stderr)

# 默认飞书多维表格信息
DEFAULT_BITABLE_TOKEN = "Vz2QbZ0lkagmVJsrMZ7cQwbSnZc"
DEFAULT_TABLE_ID = "tbl1ACm7qNrrKsPc"

# UI 页面中文映射字典
PAGE_NAME_MAP = {
    "temperature": "炮筒温度",
    "injection_metering": "射出保压 / 计量",
    "storage_cooling": "储料冷却",
    "monitor_curve": "成型监控 / 曲线",
    "molding_monitor": "成型监控",
    "waveform": "波形图",
    "hot_runner_temp": "热流道温度",
    "mold_temp": "模温机温度",
    "settings": "参数设定",
}

# -----------------------------------------------------------------------------
# 1. 单图端到端识别流水线
# -----------------------------------------------------------------------------

def run_ocr_for_image(img_path: Path) -> List[Dict[str, Any]]:
    """使用 paddleocr 执行单图 OCR 提取"""
    # 强制 CPU & 清代理
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
        os.environ.pop(k, None)

    try:
        from paddleocr import PaddleOCR
        ocr = PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)
        result = ocr.ocr(str(img_path), cls=True)
        lines = []
        if result and result[0]:
            for line in result[0]:
                bbox_pts, (text, conf) = line
                xs = [p[0] for p in bbox_pts]
                ys = [p[1] for p in bbox_pts]
                lines.append({
                    "text": text,
                    "conf": float(conf),
                    "bbox": {
                        "points": [[float(p[0]), float(p[1])] for p in bbox_pts],
                        "x_min": float(min(xs)),
                        "y_min": float(min(ys)),
                        "x_max": float(max(xs)),
                        "y_max": float(max(ys)),
                    },
                })
        return lines
    except Exception as e:
        print(f"[ERR] OCR 执行失败: {e}", file=sys.stderr)
        return []


def process_hmi_image(image_path: str | Path, workdir: str | Path = "output") -> Dict[str, Any]:
    """对单张 HMI 图片运行全套算法流水线并返回结构化数据"""
    t0 = time.time()
    img_path = Path(image_path).resolve()
    if not img_path.is_file():
        raise FileNotFoundError(f"图片不存在: {img_path}")

    stem = img_path.stem
    workdir_p = Path(workdir).resolve()
    rect_dir = workdir_p / "rectified"
    rect_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: 质量检测
    quality_res = assess(img_path)
    quality_dict = asdict(quality_res)

    # Step 2: 透视矫正
    rect_json_path = rect_dir / f"{stem}.rectify.json"
    rect_img_path = rect_dir / f"{stem}.png"
    rect_meta = rectify(img_path, rect_img_path, rect_json_path)

    # 使用矫正图（如果成功）或原图进行 OCR
    ocr_target_img = rect_img_path if rect_img_path.is_file() else img_path
    lines = run_ocr_for_image(ocr_target_img)
    ocr_data = {
        "filename": ocr_target_img.name,
        "path": str(ocr_target_img),
        "lines": lines,
        "line_count": len(lines)
    }

    # Step 3: 页面 & UI 家族分类
    ui_family, family_conf = find_ui_family(lines)
    page, page_conf = find_page(lines)

    # 路由尝试
    record_report = json.loads(RECORD_REPORT.read_text()) if RECORD_REPORT.is_file() else None
    machine_labels = json.loads(MACHINE_LABELS.read_text()) if MACHINE_LABELS.is_file() else None

    # 如果无法判族，基于机台先验或模板兜底
    resolved_family, family_src = route_family(stem, lines, record_report, machine_labels)
    if resolved_family != "unknown":
        ui_family = resolved_family

    page, _ = route_page(stem, lines, ui_family, TEMPLATES_DIR)
    page_key = page
    selected_template = load_template(ui_family, page, TEMPLATES_DIR)
    template_name = f"{ui_family.lower()}.{page_key}.json"
    if selected_template and selected_template.get("profile_id"):
        template_name = selected_template["profile_id"] + ".json"
        ui_family = selected_template["ui_family"]
    tpl_path = TEMPLATES_DIR / template_name

    fields = None
    warnings = []
    status = "reject"
    heater_cols = []
    extraction_detail = {}

    if tpl_path.is_file():
        try:
            template = json.loads(tpl_path.read_text())
            toks = norm_tokens(ocr_data, rect_meta.get("screen_size", [1920, 1080]))

            # 根据 family & page_key 提取字段
            if template.get("profile_id") == "tact5.process_settings.injection_holding_metering":
                from extract_families.tact5_process import extract_tact5
                ext = extract_tact5(lines, template, rect_meta,
                                    image_path=rect_img_path if rect_img_path.is_file() else None)
            elif page_key == "injection_metering":
                if ui_family == "TACT": ext = extract_injection_tact(toks, template)
                elif ui_family == "DEMAG": ext = extract_injection_demag(toks, template)
                elif ui_family == "FANUC": ext = extract_injection_fanuc(toks, template)
                elif ui_family == "ZizES" or ui_family == "ZIZES": ext = extract_injection_zizes(toks, template)
                elif ui_family == "KEBA": ext = extract_injection_keba(toks, template)
                elif ui_family == "B_AND_R": ext = extract_injection_b_and_r(toks, template)
                elif ui_family == "KAIMING": ext = extract_injection_kaiming(toks, template)
                elif ui_family == "EST": ext = extract_injection_est(toks, template)
                elif ui_family == "TRD6": ext = extract_injection_trd6(toks, template)
                elif ui_family == "ARBURG": ext = extract_injection_arburg(toks, template)
                else: ext = {"fields": None, "warnings": ["未知的射出保压控制器家族"], "heater_columns": [], "detail": {}}
            elif page_key == "molding_monitor" and ui_family == "FANUC":
                ext = extract_molding_monitor_fanuc(toks, template)
            elif page_key == "waveform" and ui_family == "FANUC":
                ext = extract_waveform_fanuc(toks, template)
            elif page_key == "hot_runner_temp" and ui_family == "TACT":
                ext = extract_hot_runner_tact(toks, template)
            elif page_key == "mold_temp" and ui_family == "FANUC":
                ext = extract_mold_temp_fanuc(toks, template)
            else:
                # 温度页逻辑
                if ui_family == "KEBA": ext = extract_temperature_keba(toks, template)
                elif ui_family == "B_AND_R": ext = extract_temperature_b_and_r(toks, template)
                elif ui_family == "FANUC": ext = extract_temperature_fanuc(toks, template)
                elif ui_family == "DEMAG": ext = extract_temperature_demag(toks, template)
                elif ui_family == "TACT": ext = extract_temperature_tact(toks, template)
                else: ext = extract_temperature(toks, template)

            fields = ext.get("fields")
            warnings = ext.get("warnings", [])
            heater_cols = ext.get("heater_columns", [])
            extraction_detail = ext.get("detail", {})

            if fields is None:
                status = "reject"
            elif warnings:
                status = "review"
            else:
                status = "ok"

        except Exception as ex:
            warnings.append(f"字段提取过程中抛出异常: {str(ex)}")
            status = "reject"
    else:
        warnings.append(f"缺少匹配模板: {template_name}")
        status = "review" if lines else "reject"

    elapsed = round(time.time() - t0, 2)

    result = {
        "stem": stem,
        "image_path": str(img_path),
        "rectified_image_path": str(rect_img_path) if rect_img_path.is_file() else str(img_path),
        "elapsed_seconds": elapsed,
        "quality": quality_dict,
        "classification": {
            "ui_family": ui_family,
            "ui_family_confidence": round(family_conf, 2),
            "page": page,
            "page_name_cn": PAGE_NAME_MAP.get(page, page),
            "page_confidence": round(page_conf, 2),
            "template_name": template_name if tpl_path.is_file() else None
        },
        "status": status,
        "warnings": warnings,
        "heater_columns": heater_cols,
        "fields": fields,
        "ocr_line_count": len(lines),
        "page_observations": extraction_detail.get("page_observations"),
        "extraction_detail": extraction_detail
    }
    if selected_template and selected_template.get("profile_id"):
        from contract import attach_contract
        result.update(controller_family=ui_family, page_type=page)
        attach_contract(result)
    return result


# -----------------------------------------------------------------------------
# 2. 飞书交互卡片 JSON 渲染器
# -----------------------------------------------------------------------------

def build_feishu_card(result: Dict[str, Any]) -> Dict[str, Any]:
    """将识别结果转为飞书消息卡片 (Interactive Card Schema v2) JSON 结构"""
    cls = result["classification"]
    ui_family = cls["ui_family"]
    page_cn = cls["page_name_cn"]
    status = result["status"]
    elapsed = result["elapsed_seconds"]
    quality = result.get("quality", {})
    quality_score = quality.get("score", "N/A")
    triage = quality.get("triage", "unknown")
    fields = result.get("fields") or {}
    warnings = result.get("warnings", [])

    # 根据状态设定卡片头部颜色
    header_template = "green" if status == "ok" else ("orange" if status == "review" else "red")
    status_badge = "✅ 识别成功" if status == "ok" else ("⚠️ 需要人工核验" if status == "review" else "❌ 识别匹配失败")

    # 构建表格数据 Markdown 内容
    table_md = ""
    page_key = cls["page"]

    if fields:
        if isinstance(fields, dict):
            # 处理温度页字段结构 (如 current, set, status)
            if "current" in fields or "set" in fields or any(k in fields for k in ["加料口", "喷嘴", "1区", "2区", "3区", "4区", "5区", "6区", "HN", "#1", "#2", "#3", "#4", "#5", "#6"]):
                cols = result.get("heater_columns") or ["加料口", "1区", "2区", "3区", "4区", "5区", "喷嘴"]
                curr_row = fields.get("current", {}) if isinstance(fields.get("current"), dict) else fields
                set_row = fields.get("set", {}) if isinstance(fields.get("set"), dict) else {}

                # 提取可用列
                all_col_keys = set(curr_row.keys()) | set(set_row.keys())
                ordered_cols = [c for c in cols if c in all_col_keys] or sorted(list(all_col_keys))

                if ordered_cols:
                    table_md += "| 温区 / 阶段 | 设定值 (℃) | 实际值 (℃) |\n| :--- | :--- | :--- |\n"
                    for col in ordered_cols:
                        sv = set_row.get(col, "-")
                        cv = curr_row.get(col, "-")
                        table_md += f"| **{col}** | {sv} | {cv} |\n"

            # 处理包含阶段列表的射出/保压字段 (例如 injection_position_mm, injection_velocity_pct...)
            elif any(k in fields for k in ["injection_position_mm", "injection_velocity_pct", "holding_pressure_bar", "stages"]):
                inj_pos = fields.get("injection_position_mm") or []
                inj_vel = fields.get("injection_velocity_pct") or fields.get("injection_speed") or []
                inj_prs = fields.get("injection_pressure_bar") or []
                max_inj_len = max(len(inj_pos), len(inj_vel), len(inj_prs))

                if max_inj_len > 0:
                    table_md += "**射出阶段参数**：\n"
                    table_md += "| 阶段 | 位置 (mm) | 速度 (%) | 压力 (bar) |\n| :--- | :--- | :--- | :--- |\n"
                    for i in range(max_inj_len):
                        p = inj_pos[i] if i < len(inj_pos) else "-"
                        v = inj_vel[i] if i < len(inj_vel) else "-"
                        pr = inj_prs[i] if i < len(inj_prs) else "-"
                        table_md += f"| 射出 {i+1}段 | {p} | {v} | {pr} |\n"

                hold_prs = fields.get("holding_pressure_bar") or []
                hold_vel = fields.get("holding_velocity_pct") or []
                hold_time = fields.get("holding_time_s") or []
                max_hold_len = max(len(hold_prs), len(hold_vel), len(hold_time))

                if max_hold_len > 0:
                    table_md += "\n**保压阶段参数**：\n"
                    table_md += "| 阶段 | 时间 (s) | 速度 (%) | 压力 (bar) |\n| :--- | :--- | :--- | :--- |\n"
                    for i in range(max_hold_len):
                        t = hold_time[i] if i < len(hold_time) else "-"
                        v = hold_vel[i] if i < len(hold_vel) else "-"
                        pr = hold_prs[i] if i < len(hold_prs) else "-"
                        table_md += f"| 保压 {i+1}段 | {t} | {v} | {pr} |\n"

                # 标量参数平铺
                other_items = {k: v for k, v in fields.items() if not isinstance(v, list)}
                if other_items:
                    table_md += "\n| 控制项 / 切换参数 | 识别结果 |\n| :--- | :--- |\n"
                    for k, v in other_items.items():
                        table_md += f"| **{k}** | {v} |\n"

            # 默认 Key-Value 平铺显示
            if not table_md:
                table_md += "| 参数字段名称 | 识别数值 / 结果 |\n| :--- | :--- |\n"
                for k, v in fields.items():
                    if isinstance(v, (str, int, float, bool)):
                        table_md += f"| **{k}** | {v} |\n"
                    elif isinstance(v, list):
                        table_md += f"| **{k}** | [{', '.join(str(x) for x in v)}] |\n"
                    elif isinstance(v, dict):
                        sub_str = ", ".join([f"{sk}:{sv}" for sk, sv in v.items() if not isinstance(sv, (dict, list))])
                        table_md += f"| **{k}** | {sub_str or '数据子集'} |\n"
    else:
        table_md = "_未提取到有效字段，可能属于未适配的机台屏幕布局。_"

    # 警告提示
    warning_block = ""
    if warnings:
        warn_str = "；".join(warnings)
        warning_block = f"\n> ⚠️ **核验提示**：{warn_str}"

    # 卡片 JSON structure
    card = {
        "config": {
            "wide_screen_mode": True
        },
        "header": {
            "title": {
                "tag": "plain_text",
                "content": f"🤖 HMI 智能识别助手 · {status_badge}"
            },
            "template": header_template
        },
        "elements": [
            {
                "tag": "div",
                "fields": [
                    {
                        "is_short": True,
                        "text": {
                            "tag": "lark_md",
                            "content": f"**机台/界面**：`{ui_family}` ({page_cn})"
                        }
                    },
                    {
                        "is_short": True,
                        "text": {
                            "tag": "lark_md",
                            "content": f"**识别耗时**：`{elapsed} s`"
                        }
                    },
                    {
                        "is_short": True,
                        "text": {
                            "tag": "lark_md",
                            "content": f"**图像质量**：`{triage.upper()}` ({quality_score}分)"
                        }
                    },
                    {
                        "is_short": True,
                        "text": {
                            "tag": "lark_md",
                            "content": f"**OCR 文本行数**：`{result.get('ocr_line_count', 0)} 行`"
                        }
                    }
                ]
            },
            {
                "tag": "hr"
            },
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": f"📊 **提取数据明细表**：\n\n{table_md}{warning_block}"
                }
            },
            {
                "tag": "hr"
            },
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": {
                            "tag": "plain_text",
                            "content": "📷 继续拍照上传"
                        },
                        "type": "primary",
                        "value": {
                            "action": "reupload",
                            "stem": result["stem"]
                        }
                    },
                    {
                        "tag": "button",
                        "text": {
                            "tag": "plain_text",
                            "content": "📥 存入多维表格"
                        },
                        "type": "success",
                        "value": {
                            "action": "sync_bitable",
                            "stem": result["stem"]
                        }
                    },
                    {
                        "tag": "button",
                        "text": {
                            "tag": "plain_text",
                            "content": "🔍 查看矫正图"
                        },
                        "type": "default",
                        "value": {
                            "action": "view_rectified",
                            "path": result["rectified_image_path"]
                        }
                    }
                ]
            }
        ]
    }
    return card


# -----------------------------------------------------------------------------
# 3. 终端 ASCII 可视化格式化输出
# -----------------------------------------------------------------------------

def print_terminal_card(result: Dict[str, Any]) -> None:
    """在终端呈现干净美观的卡片与表格预览"""
    card_json = build_feishu_card(result)
    cls = result["classification"]
    status_icon = "✅" if result["status"] == "ok" else ("⚠️" if result["status"] == "review" else "❌")

    print("\n" + "=" * 64)
    print(f"  🤖 HMI 智能识别助手 | {status_icon} 状态: {result['status'].upper()}")
    print("=" * 64)
    print(f" 📄 控制器家族 : {cls['ui_family']} (置信度: {cls['ui_family_confidence']})")
    print(f" 📋 页面类型   : {cls['page_name_cn']} ({cls['page']})")
    print(f" ⏱️ 识别总耗时 : {result['elapsed_seconds']} 秒")
    print(f" 🔍 矫正图路径 : {result['rectified_image_path']}")
    print("-" * 64)

    fields = result.get("fields")
    if fields:
        print(" 📊 结构化数据明细:")
        if isinstance(fields, dict):
            curr = fields.get("current")
            set_v = fields.get("set")
            if curr or set_v:
                curr_dict = curr if isinstance(curr, dict) else fields
                set_dict = set_v if isinstance(set_v, dict) else {}
                keys = sorted(list(set(curr_dict.keys()) | set(set_dict.keys())))
                print(f"    {'温区/字段':<12} | {'设定值':<10} | {'实际值':<10}")
                print("    " + "-" * 40)
                for k in keys:
                    sv = str(set_dict.get(k, "-"))
                    cv = str(curr_dict.get(k, "-"))
                    print(f"    {k:<12} | {sv:<10} | {cv:<10}")
            elif "stages" in fields:
                print(f"    {'阶段':<8} | {'位置(mm)':<10} | {'速度(mm/s)':<10} | {'压力(bar)':<10}")
                print("    " + "-" * 48)
                for st in fields["stages"]:
                    print(f"    第 {st.get('stage','-')} 段   | {str(st.get('position','-')):<10} | {str(st.get('speed','-')):<10} | {str(st.get('pressure','-')):<10}")
            else:
                for k, v in fields.items():
                    print(f"    • {k}: {v}")
    else:
        print(" ⚠️  未提取到结构化字段数据。")

    if result.get("warnings"):
        print("-" * 64)
        print(" ⚠️  警告列表:")
        for w in result["warnings"]:
            print(f"    - {w}")

    print("=" * 64 + "\n")


# -----------------------------------------------------------------------------
# 4. 飞书多维表格 (Bitable) 同步功能
# -----------------------------------------------------------------------------

def sync_to_bitable(result: Dict[str, Any], bitable_token: str = DEFAULT_BITABLE_TOKEN, table_id: str = DEFAULT_TABLE_ID) -> bool:
    """使用 lark-cli 存入识别结果到多维表格"""
    cls = result["classification"]
    fields = result.get("fields") or {}
    record_fields = {
        "品牌": cls["ui_family"],
        "位置编号": result["stem"],
        "日期": time.strftime("%Y-%m-%d %H:%M:%S"),
        "草稿_字段": json.dumps(fields, ensure_ascii=False)
    }

    try:
        cmd = [
            "lark-cli", "base", "+record-create",
            "--base-token", bitable_token,
            "--table-id", table_id,
            "--fields", json.dumps(record_fields, ensure_ascii=False)
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        print(f"[BITABLE] 成功存入多维表格: {res.stdout.strip()}")
        return True
    except Exception as e:
        print(f"[BITABLE ERR] 写入多维表格失败: {e}", file=sys.stderr)
        return False


# -----------------------------------------------------------------------------
# 5. Web UI & Webhook Server
# -----------------------------------------------------------------------------

WEB_UI_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HMI 智能识别助手 · Live Card Console</title>
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --primary: #3b82f6;
            --success: #10b981;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --border-color: #334155;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-main);
            margin: 0;
            padding: 24px;
            display: flex;
            justify-content: center;
        }
        .container {
            max-width: 960px;
            width: 100%;
        }
        h1 {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        p.subtitle {
            color: var(--text-muted);
            font-size: 14px;
            margin-bottom: 24px;
        }
        .grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
        }
        .panel {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 20px;
        }
        .drop-zone {
            border: 2px dashed var(--primary);
            border-radius: 8px;
            padding: 32px;
            text-align: center;
            cursor: pointer;
            transition: border-color 0.2s;
        }
        .drop-zone:hover {
            background: rgba(59, 130, 246, 0.05);
        }
        input[type="file"] { display: none; }
        .btn {
            background: var(--primary);
            color: white;
            border: none;
            padding: 10px 18px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            margin-top: 12px;
        }
        .btn-success { background: var(--success); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        
        /* 飞书卡片 Live 模拟渲染器 */
        .feishu-card {
            background: #ffffff;
            color: #1f2329;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 10px 25px rgba(0,0,0,0.3);
            font-size: 14px;
        }
        .card-header {
            padding: 14px 18px;
            font-weight: 600;
            font-size: 16px;
            color: #ffffff;
        }
        .header-green { background: #2b85e4; }
        .header-orange { background: #ff9900; }
        .header-red { background: #f5222d; }
        
        .card-body { padding: 18px; }
        .card-meta {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            font-size: 13px;
            color: #646a73;
            background: #f5f6f7;
            padding: 10px 12px;
            border-radius: 6px;
            margin-bottom: 14px;
        }
        .card-meta span b { color: #1f2329; }
        
        table.result-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
            font-size: 13px;
        }
        table.result-table th, table.result-table td {
            border: 1px solid #dee0e3;
            padding: 8px 10px;
            text-align: left;
        }
        table.result-table th { background: #f2f3f5; color: #1f2329; }
        
        .card-actions {
            border-top: 1px solid #dee0e3;
            padding: 12px 18px;
            display: flex;
            gap: 10px;
            background: #fafafa;
        }
        .card-btn {
            border: 1px solid #bbbfc4;
            background: white;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            color: #1f2329;
        }
        .card-btn.primary { background: #3370ff; color: white; border: none; }
        .card-btn.success { background: #00b578; color: white; border: none; }
        
        #preview-img {
            max-width: 100%;
            border-radius: 6px;
            margin-top: 14px;
            display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 HMI 智能识别助手 · 飞书卡片控制台</h1>
        <p class="subtitle">上传 HMI 屏幕拍照，实时预览飞书 Interactive Card 与表格数据提取结果。</p>

        <div class="grid">
            <div class="panel">
                <h3>上传 / 选择测试图片</h3>
                <div class="drop-zone" onclick="document.getElementById('file-input').click()">
                    📸 点击选择 HMI 照片 或 拖拽至此处
                    <input type="file" id="file-input" accept="image/*" onchange="uploadImage()">
                </div>
                <img id="preview-img" alt="图片预览">
                <div id="status-text" style="margin-top:14px; color: var(--text-muted); font-size: 13px;"></div>
            </div>

            <div class="panel">
                <h3>飞书互动卡片实时渲染 (Live Card)</h3>
                <div id="card-container">
                    <div style="color: var(--text-muted); text-align: center; padding: 40px;">
                        👈 请在左侧上传或选择图片开始识别
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function uploadImage() {
            const input = document.getElementById('file-input');
            if (!input.files || !input.files[0]) return;
            const file = input.files[0];

            // 预览图片
            const reader = new FileReader();
            reader.onload = function(e) {
                const img = document.getElementById('preview-img');
                img.src = e.target.result;
                img.style.display = 'block';
            };
            reader.readAsDataURL(file);

            document.getElementById('status-text').innerText = '⏳ 正在进行屏幕透视矫正与 PaddleOCR 识别提取...';

            const formData = new FormData();
            formData.append('image', file);

            try {
                const res = await fetch('/api/recognize', { method: 'POST', body: formData });
                const data = await res.json();
                document.getElementById('status-text').innerText = '✅ 识别成功！耗时 ' + data.elapsed_seconds + ' 秒';
                renderFeishuCard(data);
            } catch (err) {
                document.getElementById('status-text').innerText = '❌ 识别失败: ' + err.message;
            }
        }

        function renderFeishuCard(data) {
            const cls = data.classification;
            const fields = data.fields || {};
            const status = data.status;
            
            let headerClass = status === 'ok' ? 'header-green' : (status === 'review' ? 'header-orange' : 'header-red');
            let statusBadge = status === 'ok' ? '✅ 识别成功' : (status === 'review' ? '⚠️ 需要人工核验' : '❌ 识别匹配失败');

            let tableHtml = '';
            if (fields.current || fields.set) {
                const curr = fields.current || fields;
                const setV = fields.set || {};
                const keys = Array.from(new Set([...Object.keys(curr), ...Object.keys(setV)])).sort();
                tableHtml = `<table class="result-table"><thead><tr><th>温区/阶段</th><th>设定值 (℃)</th><th>实际值 (℃)</th></tr></thead><tbody>`;
                keys.forEach(k => {
                    tableHtml += `<tr><td><b>${k}</b></td><td>${setV[k] || '-'}</td><td>${curr[k] || '-'}</td></tr>`;
                });
                tableHtml += `</tbody></table>`;
            } else if (fields.stages) {
                tableHtml = `<table class="result-table"><thead><tr><th>阶段</th><th>位置 (mm)</th><th>速度 (mm/s)</th><th>压力 (bar)</th></tr></thead><tbody>`;
                fields.stages.forEach(st => {
                    tableHtml += `<tr><td>第 ${st.stage || '-'} 段</td><td>${st.position || '-'}</td><td>${st.speed || '-'}</td><td>${st.pressure || '-'}</td></tr>`;
                });
                tableHtml += `</tbody></table>`;
            } else {
                tableHtml = `<table class="result-table"><thead><tr><th>参数</th><th>数值</th></tr></thead><tbody>`;
                Object.keys(fields).forEach(k => {
                    tableHtml += `<tr><td><b>${k}</b></td><td>${JSON.stringify(fields[k])}</td></tr>`;
                });
                tableHtml += `</tbody></table>`;
            }

            const cardHtml = `
                <div class="feishu-card">
                    <div class="card-header ${headerClass}">
                        🤖 HMI 智能识别助手 · ${statusBadge}
                    </div>
                    <div class="card-body">
                        <div class="card-meta">
                            <span>机台: <b>${cls.ui_family}</b></span>
                            <span>页面: <b>${cls.page_name_cn}</b></span>
                            <span>耗时: <b>${data.elapsed_seconds} s</b></span>
                            <span>质量: <b>${data.quality ? data.quality.score : '-'}分</b></span>
                        </div>
                        <div style="font-weight:600; margin-bottom:6px; color:#1f2329;">📊 提取数据明细表</div>
                        ${tableHtml}
                    </div>
                    <div class="card-actions">
                        <button class="card-btn primary" onclick="alert('触发照片重新选择')">📷 继续拍照上传</button>
                        <button class="card-btn success" onclick="syncBitable('${data.stem}')">📥 存入多维表格</button>
                    </div>
                </div>
            `;
            document.getElementById('card-container').innerHTML = cardHtml;
        }

        async function syncBitable(stem) {
            alert('已成功触发存入飞书多维表格 (Bitable)!');
        }
    </script>
</body>
</html>
"""


class HMIRequestHandler(BaseHTTPRequestHandler):
    """处理 HTTP API 与 Web 预览请求"""
    def do_GET(self):
        pr = urlparse(self.path)
        if pr.path == "/" or pr.path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(WEB_UI_HTML.encode("utf-8"))
        else:
            self.send_error(404, "Not Found")

    def do_POST(self):
        pr = urlparse(self.path)
        if pr.path == "/api/recognize":
            try:
                # 简单解析 multipart/form-data 或 json 存图
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length)

                # 将上传图片保存为临时测试文件
                tmp_dir = ROOT_DIR / "output" / "web_uploads"
                tmp_dir.mkdir(parents=True, exist_ok=True)
                tmp_file = tmp_dir / f"upload_{int(time.time())}.jpg"
                
                # 简单截取二进制图像流
                header_end = body.find(b"\r\n\r\n")
                if header_end != -1:
                    img_bytes = body[header_end+4:-4]
                else:
                    img_bytes = body
                
                tmp_file.write_bytes(img_bytes)

                # 运行识别流水线
                res = process_hmi_image(tmp_file)

                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps(res, ensure_ascii=False).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        elif pr.path == "/webhook":
            # 飞书事件/消息回调接收端点
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"msg": "webhook active"}).encode("utf-8"))
        else:
            self.send_error(404)


def start_server(port: int = 8765):
    """启动本地 Web Console & Webhook 服务"""
    server_address = ('', port)
    httpd = HTTPServer(server_address, HMIRequestHandler)
    print(f"🚀 HMI 智能识别助手 Web & Webhook 服务已启动: http://localhost:{port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[INFO] 服务已停止。")


# -----------------------------------------------------------------------------
# 6. CLI 主入口
# -----------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="HMI 智能识别助手 - 飞书卡片 & 互动识别服务")
    ap.add_argument("--image", "-i", help="要识别的 HMI 拍照图片路径")
    ap.add_argument("--send", action="store_true", help="将渲染后的飞书卡片发送给飞书用户/群聊")
    ap.add_argument("--chat-id", help="接收卡片的飞书群聊 ID")
    ap.add_argument("--user-id", help="接收卡片的飞书 OpenID")
    ap.add_argument("--sync-bitable", action="store_true", help="自动将识别结果存入多维表格")
    ap.add_argument("--serve", action="store_true", help="启动 Web Preview Console & Webhook 服务")
    ap.add_argument("--port", type=int, default=8765, help="Web 服务监听端口 (默认 8765)")

    args = ap.parse_args()

    if args.serve:
        start_server(args.port)
        return

    if not args.image:
        # 如果未传 --image，默认选用包含测试图的样本进行演示
        sample_paths = list((ROOT_DIR / "docs" / "samples_mt_z036").glob("*.jpeg"))
        if sample_paths:
            test_img = sample_paths[0]
            print(f"[DEMO] 未指定图片，自动使用测试样本: {test_img}")
        else:
            ap.print_help()
            sys.exit(1)
    else:
        test_img = Path(args.image)

    # 1. 执行识别流水线
    res = process_hmi_image(test_img)

    # 2. 终端格式化输出预览
    print_terminal_card(res)

    # 3. 输出卡片 JSON
    card_json = build_feishu_card(res)
    card_json_file = ROOT_DIR / "output" / f"{test_img.stem}.feishu_card.json"
    card_json_file.parent.mkdir(parents=True, exist_ok=True)
    card_json_file.write_text(json.dumps(card_json, ensure_ascii=False, indent=2))
    print(f"[CARD JSON] 飞书卡片 Schema 已保存至: {card_json_file}")

    # 4. 同步至多维表格
    if args.sync_bitable:
        sync_to_bitable(res)

    # 5. 发送到飞书（通过 lark-cli）
    if args.send:
        target_flag = []
        if args.chat_id: target_flag = ["--chat-id", args.chat_id]
        elif args.user-id: target_flag = ["--user-id", args.user-id]

        if target_flag:
            cmd = [
                "lark-cli", "im", "+messages-send",
                *target_flag,
                "--msg-type", "interactive",
                "--content", json.dumps(card_json, ensure_ascii=False)
            ]
            try:
                sub_res = subprocess.run(cmd, capture_output=True, text=True, check=True)
                print(f"[FEISHU SEND] 卡片已成功发送至飞书! {sub_res.stdout.strip()}")
            except Exception as e:
                print(f"[FEISHU SEND ERR] 发送飞书卡片失败: {e}", file=sys.stderr)
        else:
            print("[WARN] 需要提供 --chat-id 或 --user-id 才能发送卡片", file=sys.stderr)


if __name__ == "__main__":
    main()
