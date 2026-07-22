#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL is required}"

case "$DATABASE_URL" in
  postgresql://*|postgres://*) ;;
  *) echo "DATABASE_URL must use PostgreSQL" >&2; exit 1 ;;
esac

for migration in prisma/migrations/*/migration.sql; do
  name="$(basename "$(dirname "$migration")")"
  [[ "$name" == "20260722160000_postgresql_baseline" ]] && continue
  npx prisma migrate resolve --applied "$name"
done

npx prisma migrate deploy
npx prisma generate
