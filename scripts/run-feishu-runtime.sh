#!/usr/bin/env bash
set -euo pipefail

cd /data1/code/agent-platform-v2

source /data1/code/agent-platform-v2/scripts/load-local-env.sh

# The user service used to inject Feishu credentials from /home/hello/.env.
# Load a repo-local fallback so the runtime can still start when that file is gone.
load_local_env_fallbacks
normalize_database_url

exec /usr/bin/bash -ic 'cd /data1/code/agent-platform-v2 && exec npm run feishu:runtime'
