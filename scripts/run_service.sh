#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
exec .venv/bin/uvicorn hmi_service:app \
  --host "${HMI_HOST:-0.0.0.0}" \
  --port "${HMI_PORT:-8765}" \
  --workers 1
