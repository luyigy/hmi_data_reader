"""HMI GPU HTTP 服务 (for mold-data-webpage-tool)

架构特性：
1. PaddleOCR 模型进程级单例驻留 GPU 内存 (gpu:0)。
2. 服务启动自动预热 (Dummy 推理)。
3. 内存直接解码图片 (cv2.imdecode)，避开磁盘 I/O 开销。
4. 提供 /health, /ready 接口，单 Worker + 信号量控制并发 (并发数 1，忙时返 429)。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

# 引入 hmi_data_reader scripts 模块
HERE = Path(__file__).resolve().parent
SCRIPTS_DIR = HERE / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from classify_ui import classify
from contract import attach_contract
from extract_fields import MACHINE_LABELS, RECORD_REPORT, extract_one
from postprocess import postprocess_one
from quality import assess
from rectify import rectify

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("hmi_service")

# 环境变量设置：默认使用 GPU 0
os.environ["CUDA_VISIBLE_DEVICES"] = os.environ.get("CUDA_VISIBLE_DEVICES", "0")
for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
    os.environ.pop(k, None)

app = FastAPI(title="HMI GPU Recognition Service", version="1.0.0")

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
async def recognize_image(file: UploadFile = File(...)):
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

            # 2. 透视矫正
            rr = rectify(orig_path, rect_png, rect_meta)
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

            # 6. 字段提取
            record_report = json.loads(RECORD_REPORT.read_text()) if RECORD_REPORT.is_file() else None
            machine_labels = json.loads(MACHINE_LABELS.read_text()) if MACHINE_LABELS.is_file() else None
            extract_res = extract_one(stem, rect_dir, record_report, machine_labels, HERE / "templates")
            # 带分类置信度重算契约键（幂等，extract 内已算过一次无分类版本）
            attach_contract(extract_res, cls_res)

            elapsed_ms = int((time.perf_counter() - start_time) * 1000)

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
                    "ui_family": cls_res.get("ui_family"),
                    "ui_family_confidence": cls_res.get("ui_family_confidence"),
                    "page": cls_res.get("page"),
                    "page_confidence": cls_res.get("page_confidence"),
                },
                "fields": extract_res.get("fields", {}),
                "hmi_variant": extract_res.get("hmi_variant"),
                "template": (extract_res.get("provenance") or {}).get("template"),
                "contract_version": extract_res.get("contract_version"),
                "profile_id": extract_res.get("profile_id"),
                "profile_confidence": extract_res.get("profile_confidence"),
                "profile_status": extract_res.get("profile_status"),
                "field_meta": extract_res.get("field_meta", {}),
                "status": extract_res.get("status"),
                "warnings": extract_res.get("warnings", []),
            }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing image recognition request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal recognition error: {str(e)}")
    finally:
        concurrency_semaphore.release()
