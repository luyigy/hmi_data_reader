#!/usr/bin/env bash
set -euo pipefail

cd /data1/code/agent-platform-v2
source scripts/load-local-env.sh
load_local_env_fallbacks
normalize_database_url

exec flock -n "${TASK_GRAPH_COORDINATOR_LOCK:-/data1/code/.agent-platform-task-graph-coordinator.lock}" \
  /usr/bin/bash -ic 'cd /data1/code/agent-platform-v2 && exec npm run task-graph:runtime'
