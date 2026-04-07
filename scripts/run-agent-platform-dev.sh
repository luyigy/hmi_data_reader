#!/usr/bin/env bash
set -euo pipefail

cd /data1/code/agent-platform-v2
exec /usr/bin/bash -lc 'cd /data1/code/agent-platform-v2 && exec npm run dev'
