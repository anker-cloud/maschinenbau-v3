#!/bin/bash
# Runs on EC2 after each CodeDeploy deployment (triggered by CodePipeline on git push).
# Pulls latest code from the repo and restarts all Docker services.

set -euo pipefail
exec >> /var/log/sturtz-deploy.log 2>&1

echo "=== Deploy started $(date) ==="

APP_DIR=/opt/sturtz/app

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: $APP_DIR does not exist. Was the initial CloudFormation bootstrap completed?"
  exit 1
fi

cd "$APP_DIR"

# Pull latest code (same branch that was configured at stack creation time)
git fetch origin
git reset --hard origin/main

# Rebuild images — Docker layer cache keeps this fast for small changes
docker compose -f docker-compose.aws.yml build

# Restart containers with zero-downtime rolling update
docker compose -f docker-compose.aws.yml up -d --remove-orphans

# If DB schema changed, push it
DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d '=' -f2-)
DATABASE_URL="$DATABASE_URL" pnpm --filter @workspace/db run push || true

echo "=== Deploy finished $(date) ==="
