#!/usr/bin/env bash
# OWASP ZAP baseline (passive) scan of the website and API.
# Passive only: it crawls and inspects responses, it does not attack.
# Still, only scan targets you own. Default target is a local dev server.
#
#   scripts/zap-baseline.sh                      # http://host.docker.internal:4317
#   scripts/zap-baseline.sh https://mercavine.com
#
# Reports land in ./zap-reports (HTML + JSON). Requires Docker.
set -euo pipefail
TARGET="${1:-http://host.docker.internal:4317}"
OUT="$(pwd)/zap-reports"
mkdir -p "$OUT"
IMAGE="ghcr.io/zaproxy/zaproxy:stable"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "== Website baseline: $TARGET"
docker run --rm --add-host=host.docker.internal:host-gateway -v "$OUT:/zap/wrk:rw" -t "$IMAGE" \
  zap-baseline.py -t "$TARGET" -m 5 -j \
  -r "site-$STAMP.html" -J "site-$STAMP.json" || SITE_RC=$?

echo "== API baseline from OpenAPI: $TARGET/api/v1/openapi.json"
docker run --rm --add-host=host.docker.internal:host-gateway -v "$OUT:/zap/wrk:rw" -t "$IMAGE" \
  zap-api-scan.py -t "$TARGET/api/v1/openapi.json" -f openapi -S \
  -r "api-$STAMP.html" -J "api-$STAMP.json" || API_RC=$?

echo "Reports: $OUT"
# ZAP exit codes: 0 pass, 1 FAIL alerts, 2 WARN only, 3 error.
exit $(( ${SITE_RC:-0} > ${API_RC:-0} ? ${SITE_RC:-0} : ${API_RC:-0} ))
