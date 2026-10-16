#!/usr/bin/env bash
set -euo pipefail
cd /data1/code/agent-platform-v2
source scripts/load-local-env.sh
load_local_env_fallbacks
normalize_database_url
export TS_NODE_BASEURL=.
export TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}'
exec /usr/bin/bash -ic 'cd /data1/code/agent-platform-v2 && exec node -r ts-node/register/transpile-only -r tsconfig-paths/register scripts/task-graph-feishu-runner.ts'
