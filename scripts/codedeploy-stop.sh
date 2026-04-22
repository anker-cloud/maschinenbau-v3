#!/bin/bash
set -e
cd /opt/sturtz/app
echo "Stopping containers before deployment..."
docker compose -f docker-compose.aws.yml down || true
echo "Containers stopped."
