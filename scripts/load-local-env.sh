#!/usr/bin/env bash

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

load_local_env_fallbacks() {
  local env_file

  for env_file in .env.feishu.local .env.runtime.local; do
    if [[ -f "$env_file" ]]; then
      load_dotenv_file "$env_file"
      break
    fi
  done
}

normalize_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is required (expected postgresql://...)" >&2
    return 1
  fi

  case "$DATABASE_URL" in
    postgresql://*|postgres://*)
      ;;
    *)
      echo "DATABASE_URL must use PostgreSQL" >&2
      return 1
      ;;
  esac
}
