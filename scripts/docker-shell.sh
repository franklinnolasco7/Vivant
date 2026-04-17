#!/usr/bin/env bash

set -euo pipefail

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose_cmd=(docker-compose)
else
  echo "Docker Compose is required. Install Docker Desktop or docker-compose." >&2
  exit 1
fi

"${compose_cmd[@]}" up -d vivant-dev
"${compose_cmd[@]}" exec vivant-dev bash
