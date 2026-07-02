#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${BRIDGE_PORT:-5680}"
BRIDGE_PID_FILE="${BRIDGE_PID_FILE:-/tmp/pikomin-host-bridge.pid}"
BRIDGE_LOG_FILE="${BRIDGE_LOG_FILE:-/tmp/pikomin-host-bridge.log}"
BRIDGE_SCREEN_NAME="${BRIDGE_SCREEN_NAME:-pikomin-host-bridge}"
TUNNEL_SCREEN_NAME="${TUNNEL_SCREEN_NAME:-pikomin-tunnel}"
bridge_url="http://${BRIDGE_HOST}:${BRIDGE_PORT}"
bridge_health_url="${bridge_url}/health"

get_docker_cmd() {
  if docker info >/dev/null 2>&1; then
    echo "docker compose"
  elif command -v sudo >/dev/null 2>&1 && sudo -H -u home docker info >/dev/null 2>&1; then
    echo "sudo -H -u home docker compose"
  else
    echo "docker compose"
  fi
}

is_bridge_healthy() {
  curl -fsS "${bridge_health_url}" | grep -q "pikomin-host-bridge"
}

is_screen_running() {
  local screen_name="$1"
  local output
  output="$(screen -list 2>/dev/null || true)"
  grep -q "${screen_name}" <<<"${output}"
}

cleanup_stale_pid() {
  if [[ -f "${BRIDGE_PID_FILE}" ]]; then
    local pid
    pid="$(cat "${BRIDGE_PID_FILE}")"
    if [[ "${pid}" == screen:* ]]; then
      local screen_name="${pid#screen:}"
      if is_screen_running "${screen_name}"; then
        return
      fi
      rm -f "${BRIDGE_PID_FILE}" 2>/dev/null || sudo rm -f "${BRIDGE_PID_FILE}" || true
      return
    fi
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      return
    fi
    rm -f "${BRIDGE_PID_FILE}" 2>/dev/null || sudo rm -f "${BRIDGE_PID_FILE}" || true
  fi
}

start_bridge() {
  cleanup_stale_pid

  if is_bridge_healthy; then
    echo "Host bridge already running: ${bridge_health_url}"
    return
  fi

  echo "Starting host bridge on ${BRIDGE_HOST}:${BRIDGE_PORT}..."
  if command -v screen >/dev/null 2>&1; then
    screen -S "${BRIDGE_SCREEN_NAME}" -X quit >/dev/null 2>&1 || true
    (
      cd "${PROJECT_DIR}"
      screen -dmS "${BRIDGE_SCREEN_NAME}" "${PYTHON_BIN}" -m uvicorn scripts.host_location_bridge:app --host "${BRIDGE_HOST}" --port "${BRIDGE_PORT}"
    )
    echo "screen:${BRIDGE_SCREEN_NAME}" > "${BRIDGE_PID_FILE}"
  else
    (
      cd "${PROJECT_DIR}"
      nohup "${PYTHON_BIN}" -m uvicorn scripts.host_location_bridge:app --host "${BRIDGE_HOST}" --port "${BRIDGE_PORT}"
    ) >"${BRIDGE_LOG_FILE}" 2>&1 &
    local pid=$!
    echo "${pid}" > "${BRIDGE_PID_FILE}"
  fi

  for _ in $(seq 1 20); do
    if is_bridge_healthy; then
      echo "Host bridge ready: ${bridge_health_url}"
      return
    fi
    if [[ -f "${BRIDGE_PID_FILE}" ]] && [[ "$(cat "${BRIDGE_PID_FILE}")" == screen:* ]]; then
      local screen_name
      screen_name="$(cat "${BRIDGE_PID_FILE}")"
      screen_name="${screen_name#screen:}"
      if ! is_screen_running "${screen_name}"; then
        echo "Host bridge exited early. Check log: ${BRIDGE_LOG_FILE}"
        tail -n 120 "${BRIDGE_LOG_FILE}" || true
        exit 1
      fi
    elif ! kill -0 "${pid}" 2>/dev/null; then
      echo "Host bridge exited early. Check log: ${BRIDGE_LOG_FILE}"
      tail -n 120 "${BRIDGE_LOG_FILE}" || true
      exit 1
    fi
    sleep 1
  done

  echo "Host bridge did not become ready in time. Check log: ${BRIDGE_LOG_FILE}"
  exit 1
}

stop_bridge() {
  cleanup_stale_pid
  if [[ ! -f "${BRIDGE_PID_FILE}" ]]; then
    echo "Host bridge is not managed by this script."
    return
  fi

  local pid
  pid="$(cat "${BRIDGE_PID_FILE}")"
  if [[ "${pid}" == screen:* ]]; then
    local screen_name="${pid#screen:}"
    echo "Stopping host bridge screen session (${screen_name})..."
    screen -S "${screen_name}" -X quit >/dev/null 2>&1 || true
    rm -f "${BRIDGE_PID_FILE}" 2>/dev/null || sudo rm -f "${BRIDGE_PID_FILE}" || true
    return
  fi
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    echo "Stopping host bridge (pid=${pid})..."
    kill "${pid}" 2>/dev/null || true
  fi
  rm -f "${BRIDGE_PID_FILE}" 2>/dev/null || sudo rm -f "${BRIDGE_PID_FILE}" || true
}

start_tunnel() {
  if sudo screen -list 2>/dev/null | grep -q "${TUNNEL_SCREEN_NAME}"; then
    echo "RSD tunnel already running."
    return
  fi

  echo "================================================="
  echo " iOS 17+ 需要啟動底層通訊通道 (RSD Tunnel)"
  echo " 接下來將會要求您輸入 Mac 登入密碼 (sudo 權限)"
  echo "================================================="
  sudo -v || { echo "Failed to obtain sudo privileges. Cannot start tunnel."; exit 1; }

  sudo screen -dmS "${TUNNEL_SCREEN_NAME}" "${PYTHON_BIN}" -m pymobiledevice3 remote tunneld
  echo "RSD tunnel started in background screen: ${TUNNEL_SCREEN_NAME}"
}

stop_tunnel() {
  if sudo screen -list 2>/dev/null | grep -q "${TUNNEL_SCREEN_NAME}"; then
    echo "Stopping RSD tunnel..."
    sudo screen -S "${TUNNEL_SCREEN_NAME}" -X quit >/dev/null 2>&1 || true
  fi
}

show_status() {
  if is_bridge_healthy; then
    echo "Host bridge: running (${bridge_health_url})"
  else
    echo "Host bridge: stopped"
  fi
  local dcmd
  dcmd="$(get_docker_cmd)"
  (
    cd "${PROJECT_DIR}"
    ${dcmd} ps
  )
}

show_logs() {
  echo "== Host bridge log =="
  tail -n 80 "${BRIDGE_LOG_FILE}" 2>/dev/null || echo "(no host bridge log yet)"
  echo ""
  echo "== Docker compose logs =="
  local dcmd
  dcmd="$(get_docker_cmd)"
  (
    cd "${PROJECT_DIR}"
    ${dcmd} logs --tail=80
  )
}

command="${1:-up}"
shift || true

dcmd="$(get_docker_cmd)"

case "${command}" in
  up)
    start_tunnel
    start_bridge
    (
      cd "${PROJECT_DIR}"
      ${dcmd} up -d "$@"
    )
    ;;
  down)
    (
      cd "${PROJECT_DIR}"
      ${dcmd} down "$@"
    )
    stop_bridge
    stop_tunnel
    ;;
  restart)
    stop_bridge
    stop_tunnel
    start_tunnel
    start_bridge
    (
      cd "${PROJECT_DIR}"
      ${dcmd} up -d --force-recreate "$@"
    )
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs
    ;;
  *)
    echo "Usage: $0 {up|down|restart|status|logs} [docker-compose-args...]"
    exit 1
    ;;
esac
