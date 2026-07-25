#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=/data1/code/agent-platform-v2
UNIT_DIR="${HOME}/.config/systemd/user"

mkdir -p "${UNIT_DIR}"
install -m 0644 "${PROJECT_ROOT}/deploy/systemd-user/agent-platform-dev.service" "${UNIT_DIR}/agent-platform-dev.service"
install -m 0644 "${PROJECT_ROOT}/deploy/systemd-user/agent-platform-feishu.service" "${UNIT_DIR}/agent-platform-feishu.service"
install -m 0644 "${PROJECT_ROOT}/deploy/systemd-user/agent-platform-scheduled-jobs.service" "${UNIT_DIR}/agent-platform-scheduled-jobs.service"

systemctl --user daemon-reload
systemctl --user enable --now agent-platform-dev.service
systemctl --user enable --now agent-platform-feishu.service
systemctl --user enable --now agent-platform-scheduled-jobs.service

echo "Installed and started:"
echo "  agent-platform-dev.service"
echo "  agent-platform-feishu.service"
echo "  agent-platform-scheduled-jobs.service"
