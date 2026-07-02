#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_PY="${BASE_DIR}/venv/bin/python"
BACKEND_PORT="${BACKEND_PORT:-5679}"
FRONTEND_PORT="${FRONTEND_PORT:-5678}"

if [[ ! -x "${VENV_PY}" ]]; then
  echo "Missing runtime: ${VENV_PY}"
  exit 1
fi

echo "Starting tunnel (TCP)..."
sudo "${VENV_PY}" -m pymobiledevice3 remote tunneld --protocol tcp &
TUNNEL_PID=$!

cleanup() {
  echo ""
  echo "Stopping services..."
  kill "${FRONTEND_PID:-0}" 2>/dev/null || true
  kill "${BACKEND_PID:-0}" 2>/dev/null || true
  kill "${TUNNEL_PID:-0}" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "Starting backend..."
(
  cd "${BASE_DIR}/backend"
  "${VENV_PY}" -m uvicorn app.main:app --host 0.0.0.0 --port "${BACKEND_PORT}"
) &
BACKEND_PID=$!

echo "Starting static frontend server..."
(
  cd "${BASE_DIR}/frontend/dist"
  "${VENV_PY}" -m http.server "${FRONTEND_PORT}"
) &
FRONTEND_PID=$!

echo "Open: http://localhost:${FRONTEND_PORT}"
echo "Press Ctrl+C to stop."
wait
