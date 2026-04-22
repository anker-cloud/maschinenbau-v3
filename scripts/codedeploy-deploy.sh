#!/bin/bash
set -e
cd /opt/sturtz/app

echo "Pulling latest code..."
git pull origin main

echo "Building Docker images..."
docker compose -f docker-compose.aws.yml build

echo "Starting containers..."
docker compose -f docker-compose.aws.yml up -d

echo "Deployment complete."
