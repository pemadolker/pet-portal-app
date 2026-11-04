#!/usr/bin/env bash
# Builds all 15 images locally. Use it for the very first deploy, or when you
# work without CI/GHCR:
#   scripts/build-images.sh ghcr.io/<org>/pet-portal 1.0.0 --kind   # build and load into the Kind cluster
#   scripts/build-images.sh ghcr.io/<org>/pet-portal 1.0.0 --push   # build and push
# The registry/tag must match envs/<env>.yaml (imageRegistry) and apps/*/values-<env>.yaml (image.tag)
# in pet-portal-config. Normally CI does this on every push to main.
set -euo pipefail
cd "$(dirname "$0")/.."
REG=${1:?registry, for example ghcr.io/myorg/pet-portal}; TAG=${2:?tag}; MODE=${3:-}
SERVICES="api-gateway signup login profile pet search shelter favorites adoption review history notification email-worker reporting"
docker build -t "$REG/frontend:$TAG" --build-arg VERSION="$TAG" frontend
for s in $SERVICES; do
  docker build -t "$REG/$s:$TAG" --build-arg SERVICE="$s" --build-arg VERSION="$TAG" .
done
all="frontend $SERVICES"
case $MODE in
  --kind) for s in $all; do kind load docker-image "$REG/$s:$TAG" --name pet-portal; done ;;
  --push) for s in $all; do docker push "$REG/$s:$TAG"; done ;;
  *) echo "Built. Add --kind or --push." ;;
esac
