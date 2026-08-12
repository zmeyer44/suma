#!/usr/bin/env bash
# Build the compute-plane image and push it to Fly's registry. Run from
# anywhere; the build context is the repo root. Requires flyctl (logged in)
# and docker.
#
#   infra/compute-image/build.sh [tag]
#
# Prints the FLY_COMPUTE_IMAGE line to set on the control plane.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_APP="${FLY_IMAGE_APP:-suma-compute-image}"
ORG="${FLY_ORG_SLUG:-personal}"
TAG="${1:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
REF="registry.fly.io/${IMAGE_APP}:${TAG}"

# The registry namespace is an app; creating it twice is fine.
fly apps create "$IMAGE_APP" --org "$ORG" >/dev/null 2>&1 || true
fly auth docker

# Fly Machines are x86_64; on Apple Silicon this builds under emulation.
docker build --platform linux/amd64 \
  -f "$REPO_ROOT/infra/compute-image/Dockerfile" -t "$REF" "$REPO_ROOT"
docker push "$REF"

echo
echo "Image pushed. Configure the control plane with:"
echo "  FLY_COMPUTE_IMAGE=$REF"
