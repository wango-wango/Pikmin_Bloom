#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PMD3="${PMD3:-$HOME/Library/Python/3.9/bin/pymobiledevice3}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
BACKEND_PORT="${BACKEND_PORT:-5679}"
FRONTEND_PORT="${FRONTEND_PORT:-5678}"
FRONTEND_URL="http://localhost:${FRONTEND_PORT}"
TUNNEL_STATUS_URL="${TUNNEL_STATUS_URL:-http://127.0.0.1:49151}"

BACKEND_LOG="$(mktemp -t pikomin-backend.XXXXXX.log)"
FRONTEND_LOG="$(mktemp -t pikomin-frontend.XXXXXX.log)"
TUNNEL_LOG="$(mktemp -t pikomin-tunnel.XXXXXX.log)"

cleanup() {
  local code=$?
  echo ""
  echo "Stopping services..."
  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "${FRONTEND_PID}" 2>/dev/null; then
    kill "${FRONTEND_PID}" 2>/dev/null || true
  fi
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill "${BACKEND_PID}" 2>/dev/null || true
  fi
  if [[ -n "${TUNNEL_PID:-}" ]] && kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    kill "${TUNNEL_PID}" 2>/dev/null || true
  fi
  wait || true
  echo "Logs:"
  echo "  Tunnel:   ${TUNNEL_LOG}"
  echo "  Backend:  ${BACKEND_LOG}"
  echo "  Frontend: ${FRONTEND_LOG}"
  exit "$code"
}
trap cleanup INT TERM EXIT

if [[ ! -x "${PMD3}" ]]; then
  echo "pymobiledevice3 not found at: ${PMD3}"
  echo "Set PMD3 env var, for example:"
  echo "  PMD3=/path/to/pymobiledevice3 ./start.sh"
  exit 1
fi

PY_MINOR="$("${PYTHON_BIN}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")"
if [[ "${PY_MINOR}" != "3.13" ]]; then
  echo "Python 3.13 is required for iOS 18.2+ TCP tunnel support."
  echo "Current Python: ${PY_MINOR} (${PYTHON_BIN})"
  echo "Please switch Python and retry, for example:"
  echo "  PYTHON_BIN=python3.13 ./start.sh"
  exit 1
fi

echo "Starting iOS GPS simulator in one terminal..."
echo "Project: ${PROJECT_DIR}"

echo "1/3 Starting TCP tunneld (sudo password may be required)..."
sudo "${PMD3}" remote tunneld --protocol tcp >"${TUNNEL_LOG}" 2>&1 &
TUNNEL_PID=$!

for _ in $(seq 1 25); do
  if ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    echo "Tunnel exited early. Check log: ${TUNNEL_LOG}"
    sed -n '1,120p' "${TUNNEL_LOG}" || true
    exit 1
  fi

  if curl -fsS "${TUNNEL_STATUS_URL}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "${TUNNEL_STATUS_URL}" >/dev/null 2>&1; then
  echo "tunneld API is not reachable at ${TUNNEL_STATUS_URL}."
  echo "Check log: ${TUNNEL_LOG}"
  sed -n '1,160p' "${TUNNEL_LOG}" || true
  exit 1
fi

TUNNEL_JSON="$(curl -fsS "${TUNNEL_STATUS_URL}" || echo "{}")"
if [[ "${TUNNEL_JSON}" == "{}" ]]; then
  echo "Tunnel daemon is up, but no device tunnel is available yet."
  echo "Keep phone unlocked, connected via USB/Wi-Fi, then retry."
  echo "Tunnel status: ${TUNNEL_JSON}"
  exit 1
fi

echo "Tunnel ready: ${TUNNEL_JSON}"

echo "2/3 Starting backend on :${BACKEND_PORT}..."
(
  cd "${PROJECT_DIR}/backend"
  "${PYTHON_BIN}" -m uvicorn app.main:app --host 0.0.0.0 --port "${BACKEND_PORT}"
) >"${BACKEND_LOG}" 2>&1 &
BACKEND_PID=$!

sleep 1
if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
  echo "Backend failed to start. Check log: ${BACKEND_LOG}"
  sed -n '1,160p' "${BACKEND_LOG}" || true
  exit 1
fi

echo "3/3 Starting frontend on :${FRONTEND_PORT}..."
(
  cd "${PROJECT_DIR}/frontend"
  npm run dev -- --host 0.0.0.0 --port "${FRONTEND_PORT}"
) >"${FRONTEND_LOG}" 2>&1 &
FRONTEND_PID=$!

sleep 1
if ! kill -0 "${FRONTEND_PID}" 2>/dev/null; then
  echo "Frontend failed to start. Check log: ${FRONTEND_LOG}"
  sed -n '1,160p' "${FRONTEND_LOG}" || true
  exit 1
fi

echo ""
echo "All services are running."
echo "Open: ${FRONTEND_URL}"
echo "Press Ctrl+C to stop everything."
echo ""
echo "Live logs:"
echo "  tail -f ${TUNNEL_LOG}"
echo "  tail -f ${BACKEND_LOG}"
echo "  tail -f ${FRONTEND_LOG}"
echo ""

wait
