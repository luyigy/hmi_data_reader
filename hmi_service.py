"""HMI GPU HTTP 服务 (for mold-data-webpage-tool)

架构特性：
1. PaddleOCR 模型进程级单例驻留 GPU 内存 (gpu:0)。
2. 服务启动自动预热 (Dummy 推理)。
3. 内存直接解码图片 (cv2.imdecode)，避开磁盘 I/O 开销。
4. 提供 /health, /ready 接口，单 Worker + 信号量控制并发 (并发数 1，忙时返 429)。
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import logging
import os
import sys
import tempfile
import time
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Any

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# 引入 hmi_data_reader scripts 模块
HERE = Path(__file__).resolve().parent
SCRIPTS_DIR = HERE / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from classify_ui import classify
from contract import attach_contract, validate_channel_observations
from extract_fields import (MACHINE_LABELS, RECORD_REPORT, cell_rescue_better,
                            cell_rescue_needed, extract_one, merge_variant_lines)
from postprocess import postprocess_one
from quality import THRESHOLD_PERSPECTIVE, assess, measure_perspective
from rectify import DEFAULT_MAX_SIZE, rectify
from vlm_qwen import VlmError, draft_from_ocr
from page_template_admin import router as page_template_router
from extractor_capabilities import router as capabilities_router
from page_template_registry import BLOCKED_PAGE_SOURCES

# 083 S01 分辨率救援：提取失败时按此 max_size 重跑一轮矫正+OCR（见 run_attempt 调用处）
RESCUE_MAX_SIZE = 4000

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("hmi_service")

# 环境变量设置：默认使用 GPU 0
os.environ["CUDA_VISIBLE_DEVICES"] = os.environ.get("CUDA_VISIBLE_DEVICES", "0")
for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
    os.environ.pop(k, None)

app = FastAPI(title="HMI GPU Recognition Service", version="1.0.0")
app.include_router(page_template_router)
app.include_router(capabilities_router)
cors_origins = [origin.strip() for origin in os.getenv("HMI_CORS_ORIGINS", "*").split(",")
                if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def authenticate_recognition(request: Request, call_next):
    """Optional shared Bearer token; unset HMI_API_KEY keeps current open behavior."""
    expected = os.getenv("HMI_API_KEY", "").strip()
    protected = request.url.path in ("/api/v1/recognize", "/recognize", "/api/v1/draft") or (
        request.method == "GET" and request.url.path.startswith(("/api/v1/page-templates", "/api/v1/capabilities")))
    if expected and protected:
        supplied = request.headers.get("authorization", "")
        if not supplied.startswith("Bearer ") or not hmac.compare_digest(
                supplied.removeprefix("Bearer ").strip(), expected):
            return JSONResponse(status_code=401, content={"detail": "Invalid bearer token"})
    return await call_next(request)

# 全局模型与状态
ocr_model: Any = None
is_ready: bool = False
concurrency_semaphore = asyncio.Semaphore(1)


def init_ocr_engine():
    global ocr_model, is_ready
    logger.info("Initializing PaddleOCR model on GPU...")
    try:
        import paddle
        if paddle.is_compiled_with_cuda():
            paddle.set_device("gpu:0")
            logger.info("Paddle execution device set to gpu:0")
        else:
            logger.warning("Paddle is not compiled with CUDA, falling back to CPU")
    except Exception as e:
        logger.warning(f"Paddle CUDA check warning: {e}")

    from paddleocr import PaddleOCR
    # 模型进程级单例
    ocr_model = PaddleOCR(
        use_angle_cls=False,
        lang="ch",
        show_log=False,
    )

    # Dummy 预热
    logger.info("Executing Dummy warmup inference...")
    dummy_img = np.zeros((100, 100, 3), dtype=np.uint8)
    _ = ocr_model.ocr(dummy_img, cls=False)
    is_ready = True
    logger.info("PaddleOCR model ready and pre-warmed successfully!")


@app.on_event("startup")
async def startup_event():
    # 异步线程池初始化模型，避免阻塞事件循环
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, init_ocr_engine)


@app.get("/health")
async def health_check():
    return {"status": "ok"}


@app.get("/ready")
async def readiness_check():
    if is_ready:
        return {"status": "ready"}
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"status": "initializing", "message": "Model loading or warming up"}
    )


@app.post("/api/v1/recognize")
@app.post("/recognize")
async def recognize_image(file: UploadFile = File(...), include_review_image: bool = False):
    if not is_ready:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Recognition service is still initializing"
        )

    # 尝试获取信号量控制并发 (单并发限制)
    try:
        acquired = concurrency_semaphore.locked()
        if acquired:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Service busy, concurrency limit reached"
            )
        await concurrency_semaphore.acquire()
    except Exception:
        raise

    start_time = time.perf_counter()
    try:
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Empty file uploaded")

        # 内存解码
        np_arr = np.frombuffer(content, np.uint8)
        img_bgr = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if img_bgr is None:
            raise HTTPException(status_code=400, detail="Invalid image file format")

        # 临时文件目录，适配既有模块接口
        with tempfile.TemporaryDirectory(prefix="hmi_req_") as tmp_dir:
            tmp_path = Path(tmp_dir)
            orig_path = tmp_path / "raw_upload.png"
            cv2.imwrite(str(orig_path), img_bgr)
            stem = "raw_upload"

            rect_dir = tmp_path / "rectified"
            rect_dir.mkdir(exist_ok=True)
            rect_png = rect_dir / f"{stem}.png"
            rect_meta = rect_dir / f"{stem}.rectify.json"
            ocr_json = rect_dir / f"{stem}.ocr.json"

            # 1. 质量评估
            q_report = assess(orig_path)

            # 1a. 可矫正透视补救（083 S05）：唯一红灯原因为 SEVERE_PERSPECTIVE 且
            # 屏幕四角命中（rectify 可矫正）时，先透视矫正，再对矫正图复测透视比
            # （同一测量口径与阈值；模糊/反光/裁切等其余判据仍在原图上评估，
            # 不因此放宽）。复测达标才降级黄灯继续，否则维持原拒识。
            if (q_report.triage == "red"
                    and q_report.reject_codes == ["SEVERE_PERSPECTIVE"]
                    and q_report.metrics.corners_found):
                rr0 = rectify(orig_path, rect_png, rect_meta)
                ratio2 = measure_perspective(rect_png) if rr0.get("ok") else float("inf")
                if ratio2 <= THRESHOLD_PERSPECTIVE:
                    logger.info("SEVERE_PERSPECTIVE rectified: %.3f -> %.3f",
                                q_report.metrics.perspective_ratio, ratio2)
                    q_report.triage = "yellow"
                    q_report.reject_codes = []
                    q_report.warn_codes = q_report.warn_codes + [
                        f"PERSPECTIVE_RECTIFIED({q_report.metrics.perspective_ratio:.2f}"
                        f"->{ratio2:.2f})"]

            # 1b. 权威质量门禁前移（064 S02）：triage=red 在重 OCR/召回旁车之前短路，
            # 返回与正常路径兼容的结构化拒识（quality 块四字段 + success/status/fields
            # 契约键，与 Web backend/app/hmi_recognition/schemas.py 对齐）。
            # yellow/green 继续走下方现有流程，字段与行为不变。
            if q_report.triage == "red":
                elapsed_ms = int((time.perf_counter() - start_time) * 1000)
                logger.info("quality gate red short-circuit: %s", q_report.reject_codes)
                return {
                    "success": True,
                    "processing_time_ms": elapsed_ms,
                    "quality": {
                        "triage": q_report.triage,
                        "reject_codes": q_report.reject_codes,
                        "warn_codes": q_report.warn_codes,
                        "reshoot_guidance": q_report.reshoot_guidance,
                    },
                    "classification": {
                        "ui_family": None,
                        "ui_family_confidence": None,
                        "page": None,
                        "page_confidence": None,
                    },
                    "fields": {},
                    "hmi_variant": None,
                    "controller_family": None,
                    "page_type": None,
                    "template": None,
                    "contract_version": None,
                    "profile_id": None,
                    "profile_confidence": None,
                    "profile_status": None,
                    "field_meta": {},
                    "status": "reject",
                    "warnings": [],
                }

            def run_attempt(max_size: int):
                """单轮 矫正→OCR→后处理→分类→旁车→提取（083 S01 抽出以支持分辨率救援）。

                第二轮重跑前清理旁车 sidecar，避免跨轮串扰。
                """
                for sidecar in rect_dir.glob(f"{stem}.ocr_*.json"):
                    sidecar.unlink()
                # 2. 透视矫正
                rr = rectify(orig_path, rect_png, rect_meta, max_size=max_size)
                ocr_target = rect_png if rr["ok"] else orig_path

                # 3. OCR 识别 (使用 GPU 常驻模型)
                lines = []
                ocr_result = ocr_model.ocr(str(ocr_target), cls=False)
                if ocr_result and ocr_result[0]:
                    for line in ocr_result[0]:
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

                ocr_data = {
                    "filename": orig_path.name,
                    "path": str(ocr_target),
                    "model": "paddleocr-2.7.3 (GPU singleton)",
                    "line_count": len(lines),
                    "lines": lines,
                }
                ocr_json.write_text(json.dumps(ocr_data, ensure_ascii=False, indent=2))

                # 4. 后处理
                pp_data = postprocess_one(ocr_json)
                pp_path = rect_dir / f"{stem}.ocr.postprocessed.json"
                pp_path.write_text(json.dumps(pp_data, ensure_ascii=False, indent=2))

                # 5. 分类
                cls_res = classify(ocr_json)

                # 5b. 摩尔纹抑制变体（034_FIX）：仅 DEMAG 注射/保压页生成 sidecar，
                # 合并时主 OCR 值优先；变体失败不影响主路径。
                if (
                    str(cls_res.get("ui_family") or "").upper() == "DEMAG"
                    and cls_res.get("page") in ("injection_metering", "monitor_curve")
                ):
                    try:
                        from ocr_variants import generate_moire_sidecar
                        generate_moire_sidecar(
                            ocr_model, ocr_target, rect_dir / f"{stem}.ocr_moire.json"
                        )
                    except Exception as variant_error:  # noqa: BLE001
                        logger.warning("moire variant failed: %s", variant_error)

                # 5c. CLAHE 召回变体（2026-08-08）：分类器未认出家族的图片（热流道温控箱等
                # 数码管面板常漏检），生成 CLAHE sidecar——extract 的模板指纹兜底判族与
                # TACT/KEBA/B_AND_R 等家族的 CLAHE 合并均复用该产物，失败不影响主路径。
                if str(cls_res.get("ui_family") or "").strip().lower() in ("", "unknown"):
                    try:
                        from ocr_variants import generate_clahe_sidecar
                        generate_clahe_sidecar(
                            ocr_model, ocr_target, rect_dir / f"{stem}.ocr_clahe.json"
                        )
                    except Exception as variant_error:  # noqa: BLE001
                        logger.warning("clahe variant failed: %s", variant_error)
                    # 5e. 模温机数码管旁车（042 S04）：独立设备整机照片无屏幕可矫正，
                    # rectify 可能把机箱盖误判为屏幕扭曲丢内容，故旁车同时作用于矫正图
                    # （mt_cell）与原图（mt_cell_orig）两个坐标系，由提取器分系聚行；
                    # 仅 mold_temp 模板路由命中时才被 extract 合并，失败不影响主路径。
                    try:
                        from ocr_variants import generate_mold_temp_display_sidecar
                        mt_sources = [(ocr_target, "mt_cell")]
                        if ocr_target != orig_path:
                            mt_sources.append((orig_path, "mt_cell_orig"))
                        generate_mold_temp_display_sidecar(
                            ocr_model, mt_sources, rect_dir / f"{stem}.ocr_mt.json"
                        )
                    except Exception as variant_error:  # noqa: BLE001
                        logger.warning("mold_temp display variant failed: %s", variant_error)
                # 三类炮筒 Profile 的专用弱读格召回；结构不匹配时 FANUC helper 返回 0，
                # 不会把其他页面硬塞进温度提取器。
                try:
                    from ocr_variants import (generate_demag_rate_sidecar,
                                              generate_fanuc_temperature_cells_sidecar)
                    family = str(cls_res.get("ui_family") or "").upper()
                    if family == "DEMAG" and cls_res.get("page") == "temperature":
                        generate_demag_rate_sidecar(
                            ocr_model, ocr_target, rect_dir / f"{stem}.ocr_rates.json")
                    elif family == "FANUC" and cls_res.get("page") == "temperature":
                        generate_fanuc_temperature_cells_sidecar(
                            ocr_model, ocr_target, rect_dir / f"{stem}.ocr_cells.json",
                            lines, rr["screen_size"])
                except Exception as variant_error:  # noqa: BLE001
                    logger.warning("barrel cell variant failed: %s", variant_error)

                # 6. 字段提取
                record_report = json.loads(RECORD_REPORT.read_text()) if RECORD_REPORT.is_file() else None
                machine_labels = json.loads(MACHINE_LABELS.read_text()) if MACHINE_LABELS.is_file() else None
                extract_res = extract_one(stem, rect_dir, record_report, machine_labels, HERE / "templates")
                if (extract_res.get("profile_id") == "tact5.process_settings.injection_holding_metering"
                        and rr.get("ok")):
                    try:
                        from extract_families.tact5_process import recover_stage_counts
                        counts = ((extract_res.get("extraction_detail") or {})
                                  .get("page_observations") or {}).get("stage_counts", {})
                        missing = {"injection", "plasticizing"} - counts.keys()
                        extra = recover_stage_counts(ocr_model, ocr_target, lines,
                                                     rr["screen_size"], missing)
                    except Exception as rescue_error:  # noqa: BLE001
                        logger.warning("TACT5 stage count rescue failed: %s", rescue_error)
                        extra = []
                    try:
                        # 小字时间单位（射出/中间的 s）整屏漏检：仅在值框右侧裁出
                        # 唯一高置信单位字符时补行，与段数补读同次重提取生效。
                        from extract_families.tact5_process import recover_time_units
                        observations = ((extract_res.get("extraction_detail") or {})
                                        .get("page_observations") or {}).get("fields", [])
                        template = json.loads(
                            (HERE / "templates" / f"{extract_res['profile_id']}.json").read_text())
                        extra += recover_time_units(ocr_model, ocr_target, observations,
                                                    template, rr["screen_size"])
                    except Exception as rescue_error:  # noqa: BLE001
                        logger.warning("TACT5 time unit rescue failed: %s", rescue_error)
                    if extra:
                        lines.extend(extra)
                        ocr_data["lines"] = lines
                        ocr_data["line_count"] = len(lines)
                        ocr_json.write_text(json.dumps(ocr_data, ensure_ascii=False, indent=2))
                        extract_res = extract_one(stem, rect_dir, record_report,
                                                  machine_labels, HERE / "templates")
                # 6b. 083 S03 温度表逐格重读救援：B&R/DEMAG 温度页缺格/列结构失败时，
                # 按实测网格逐格 rec 重读生成旁车（ocr_tcells）后重提取一次；
                # 仅缺格变少才采用，网格实测失败不生成旁车、保持原结果。
                if cell_rescue_needed(extract_res):
                    try:
                        from ocr_variants import generate_temperature_cells_sidecar
                        base_lines = json.loads(ocr_json.read_text()).get("lines", [])
                        clahe_path = rect_dir / f"{stem}.ocr_clahe.json"
                        if clahe_path.is_file():
                            base_lines, _ = merge_variant_lines(
                                base_lines,
                                json.loads(clahe_path.read_text()).get("lines", []))
                        n_cells = generate_temperature_cells_sidecar(
                            ocr_model, ocr_target, rect_dir / f"{stem}.ocr_tcells.json",
                            extract_res.get("controller_family"), base_lines,
                            rr["screen_size"],
                            measured=extract_res.get("extraction_detail"))
                        if n_cells:
                            ext2 = extract_one(stem, rect_dir, record_report,
                                               machine_labels, HERE / "templates")
                            if cell_rescue_better(extract_res, ext2):
                                ext2.setdefault("warnings", []).append(
                                    f"CELL_GRID_RESCUE({n_cells})")
                                extract_res = ext2
                    except Exception as rescue_error:  # noqa: BLE001
                        logger.warning("temperature cell rescue failed: %s", rescue_error)
                # 带分类置信度重算契约键（幂等，extract 内已算过一次无分类版本）
                attach_contract(extract_res, cls_res)
                review_image = {}
                if include_review_image:
                    ok, jpeg = cv2.imencode(".jpg", cv2.imread(str(ocr_target)),
                                            [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if not ok or jpeg.nbytes > 4_000_000:
                        raise ValueError("OCR review image could not be encoded within limit")
                    review_image["_review_image"] = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
                return cls_res, extract_res, {
                    **review_image,
                    "_rectify_meta": rr,
                    "model": ocr_data["model"],
                    "screen_size": rr["screen_size"],
                    "lines": [{
                        "text": line["text"],
                        "confidence": line["conf"],
                        "bbox": [line["bbox"][key] for key in
                                 ("x_min", "y_min", "x_max", "y_max")],
                    } for line in lines],
                }

            cls_res, extract_res, ocr_evidence = run_attempt(DEFAULT_MAX_SIZE)
            if extract_res.get("fields") is None and not any(
                    "NO_TEMPLATE" in w or "RECTIF" in w or w in BLOCKED_PAGE_SOURCES.values()
                    for w in extract_res.get("warnings", [])):
                # 083 S01 分辨率救援：提取失败（非路由/模板缺失）时以更高 max_size
                # 重跑一轮——4K 原图经 2000 长边封顶后小字表格（B&R 灰底温度表等）
                # 降采样过度整表漏读。仅在救援轮提取出字段时采用，否则保留原拒识。
                cls2, ext2, evidence2 = run_attempt(RESCUE_MAX_SIZE)
                if ext2.get("fields") is not None:
                    cls_res, extract_res, ocr_evidence = cls2, ext2, evidence2
                    extract_res.setdefault("warnings", []).append(
                        f"RESCUE_HI_RES({RESCUE_MAX_SIZE})")

            elapsed_ms = int((time.perf_counter() - start_time) * 1000)

            review_image = ocr_evidence.pop("_review_image", None)
            rectify_meta = ocr_evidence.pop("_rectify_meta", {})
            page_observations = (extract_res.get("extraction_detail") or {}).get("page_observations")
            if page_observations and page_observations.get("fields"):
                from extract_families.tact5_process import project_boxes
                project_boxes(page_observations["fields"], rectify_meta)
                for observation in page_observations["fields"]:
                    if observation.get("original_bbox") is None and "source_box_unavailable" not in observation["reasons"]:
                        observation["reasons"].append("source_box_unavailable")
            field_sources = {}
            source_rows = (extract_res.get("extraction_detail") or {}).get("field_sources", {})
            if source_rows:
                from extract_families.tact5_process import project_boxes
                for name, sources in source_rows.items():
                    observations = []
                    for source in sources:
                        index = source["line_index"]
                        if index >= len(ocr_evidence["lines"]) or ocr_evidence["lines"][index]["text"] != source["text"]:
                            continue
                        bbox = ocr_evidence["lines"][index]["bbox"]
                        width, height = ocr_evidence["screen_size"]
                        center = [(bbox[0] + bbox[2]) / (2 * width), (bbox[1] + bbox[3]) / (2 * height)]
                        if "center" in source and any(abs(a - b) > 0.0001 for a, b in zip(source["center"], center)):
                            continue
                        observations.append({"line_index": index, "bbox": bbox,
                                             "original_bbox": None})
                    project_boxes(observations, rectify_meta)
                    if observations:
                        field_sources[name] = observations
            response = {
                **({"ocr_review_image": review_image} if review_image else {}),
                "success": True,
                "processing_time_ms": elapsed_ms,
                "quality": {
                    "triage": q_report.triage,
                    "reject_codes": q_report.reject_codes,
                    "warn_codes": q_report.warn_codes,
                    "reshoot_guidance": q_report.reshoot_guidance,
                },
                "classification": {
                    "ui_family": cls_res.get("ui_family"),
                    "ui_family_confidence": cls_res.get("ui_family_confidence"),
                    "page": cls_res.get("page"),
                    "page_confidence": cls_res.get("page_confidence"),
                },
                "fields": extract_res.get("fields", {}),
                "hmi_variant": extract_res.get("hmi_variant"),
                # 039_FIX：模板指纹兜底解析出的家族/页面（classify_ui 关键词表之外的家族
                # 如 EST）必须透出，否则响应里只剩 classification 的 unknown，Web 门禁误杀。
                "controller_family": extract_res.get("controller_family"),
                "page_type": extract_res.get("page_type"),
                "template": (extract_res.get("provenance") or {}).get("template"),
                "contract_version": extract_res.get("contract_version"),
                "profile_id": extract_res.get("profile_id"),
                "profile_confidence": extract_res.get("profile_confidence"),
                "profile_status": extract_res.get("profile_status"),
                "field_meta": extract_res.get("field_meta", {}),
                "field_sources": field_sources,
                "status": extract_res.get("status"),
                "warnings": extract_res.get("warnings", []),
                # OCR evidence is independently useful even when template extraction rejects.
                # Import safety remains governed by status/profile/contract in the Web layer.
                "ocr_evidence": ocr_evidence,
                "page_observations": page_observations,
            }
            # Layer 1 禁用段图像观测（契约 2.4.0 additive）：无图像观测时缺省不出
            stage_enabled = (extract_res.get("extraction_detail") or {}).get("stage_enabled")
            if stage_enabled is not None:
                response["stage_enabled"] = stage_enabled
            # 热流道逐槽位通道观察（契约 2.8.0 additive，057 S01）：信任边界校验
            # 失败时降级缺省，不阻断识别响应；旧 hot_runner_sv_c 视图保持不变
            observations = validate_channel_observations(
                (extract_res.get("extraction_detail") or {}).get(
                    "hot_runner_channel_observations"))
            if observations is not None:
                response["hot_runner_channel_observations"] = observations
            return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing image recognition request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal recognition error")
    finally:
        concurrency_semaphore.release()


def _draft_ocr_evidence(image):
    """Reuse raw OCR only; all bounding boxes refer to the uploaded image."""
    from ocr_variants import run_ocr

    with tempfile.TemporaryDirectory(prefix="hmi_draft_") as tmp:
        path = Path(tmp) / "upload.png"
        if not cv2.imwrite(str(path), image):
            raise OSError("Could not prepare draft OCR image")
        lines = run_ocr(ocr_model, path)
    return {"screen_size": [image.shape[1], image.shape[0]], "lines": [{
        "text": line["text"], "confidence": line["conf"],
        "bbox": [line["bbox"][key] for key in
                 ("x_min", "y_min", "x_max", "y_max")],
    } for line in lines]}


@app.post("/api/v1/draft")
async def draft_image(file: UploadFile = File(...), target: Annotated[str, Form()] = "",
                      current_structure: Annotated[str, Form()] = "{}",
                      allowed_fields: Annotated[str, Form()] = "[]",
                      message: Annotated[str, Form()] = "",
                      ocr_evidence: Annotated[str, Form()] = "",
                      mode: Annotated[str, Form()] = "vision"):
    """Return candidates without page routing; mode follows draft_from_ocr."""
    try:
        structure = json.loads(current_structure)
        fields = json.loads(allowed_fields)
        evidence = json.loads(ocr_evidence) if ocr_evidence else None
    except (json.JSONDecodeError, TypeError) as exc:
        raise HTTPException(status_code=422, detail="Invalid draft context JSON") from exc
    if (mode not in {"vision", "ocr_text"}
            or not isinstance(structure, dict) or not isinstance(fields, list)
            or (ocr_evidence and not isinstance(evidence, dict))):
        raise HTTPException(status_code=422, detail="候选请求上下文非法")
    content = await file.read(20 * 1024 * 1024 + 1)
    if not content:
        raise HTTPException(status_code=400, detail="Empty file uploaded")
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=422, detail="候选请求上下文非法")
    image = cv2.imdecode(np.frombuffer(content, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image file format")
    if concurrency_semaphore.locked():
        raise HTTPException(status_code=429, detail="Service busy, concurrency limit reached")
    await concurrency_semaphore.acquire()
    try:
        ocr_question = None
        if evidence is None:
            evidence = {"lines": []}
            if is_ready and ocr_model is not None:
                try:
                    evidence = await asyncio.to_thread(_draft_ocr_evidence, image)
                except Exception:
                    logger.warning("Draft OCR failed; using uploaded image", exc_info=True)
                    ocr_question = "OCR 获取失败，本次依据原图生成候选，请逐项核对。"
            else:
                ocr_question = "OCR 尚不可用，本次依据原图生成候选，请逐项核对。"
        try:
            result = await asyncio.to_thread(
                draft_from_ocr, evidence, message,
                target, structure, fields, content, mode)
        except VlmError as exc:
            request_errors = {"候选请求上下文非法", "canonical hint 定义非法", "OCR evidence 非法"}
            status_code = 422 if str(exc) in request_errors else 502
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        if ocr_question:
            result["questions"].append(ocr_question)
        return result
    finally:
        concurrency_semaphore.release()
