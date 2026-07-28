#!/usr/bin/env bash
set -euo pipefail

cd /data1/code/agent-platform-v2
source scripts/load-local-env.sh
load_local_env_fallbacks
normalize_database_url

exec /usr/bin/bash -ic 'cd /data1/code/agent-platform-v2 && exec npm run scheduled-jobs:runtime'
