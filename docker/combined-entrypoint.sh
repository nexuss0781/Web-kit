#!/bin/sh
set -eu

SEARXNG_INTERNAL_URL="${WEBKIT_SEARXNG_URL:-http://127.0.0.1:8081}"
SEARXNG_INTERNAL_URL="${SEARXNG_INTERNAL_URL%/}"

# The combined image always runs SearXNG on the internal loopback port.
export SEARXNG_SETTINGS_PATH="${SEARXNG_SETTINGS_PATH:-/etc/searxng/settings.yml}"

export GRANIAN_HOST=127.0.0.1
export GRANIAN_PORT=8081

/usr/local/searxng/.venv/bin/granian searx.webapp:app >/tmp/searxng.log 2>&1 &
searxng_pid=$!

cleanup() {
  kill "$searxng_pid" 2>/dev/null || true
  wait "$searxng_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

ready=0
for i in $(seq 1 60); do
  if python3 - "$SEARXNG_INTERNAL_URL/search?q=healthcheck&format=json" <<'PY'
import sys
import urllib.request

try:
    with urllib.request.urlopen(sys.argv[1], timeout=1) as response:
        if response.status < 500:
            raise SystemExit(0)
except Exception:
    pass
raise SystemExit(1)
PY
  then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "SearXNG did not become ready" >&2
  cat /tmp/searxng.log >&2 || true
  exit 1
fi

exec /usr/local/bin/web-kit
