#!/usr/bin/env bash
set -euo pipefail

cd /data1/code/agent-platform-v2

load_dotenv_file() {
  local env_file="$1"
  local line key value

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"

    if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi

    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export }"
    fi

    if [[ "$line" != *=* ]]; then
      continue
    fi

    key="${line%%=*}"
    value="${line#*=}"

    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"

    if [[ -z "$key" ]]; then
      continue
    fi

    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi

    printf -v "$key" '%s' "$value"
    export "$key"
  done < "$env_file"
}

# The user service used to inject Feishu credentials from /home/hello/.env.
# Load a repo-local fallback so the runtime can still start when that file is gone.
for env_file in .env.feishu.local .env.runtime.local; do
  if [[ -f "$env_file" ]]; then
    load_dotenv_file "$env_file"
    break
  fi
done

exec /usr/bin/bash -ic 'cd /data1/code/agent-platform-v2 && exec npm run feishu:runtime'
