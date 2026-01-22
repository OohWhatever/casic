#!/usr/bin/env bash
set -e

echo "Stopping containers..."
docker compose down

VOLUME_NAME="${COMPOSE_PROJECT_NAME:-casic}_db_data"
echo "Removing volume ${VOLUME_NAME}..."
docker volume rm "${VOLUME_NAME}"

echo "Starting fresh environment..."
docker compose up -d --build
echo "Done."
