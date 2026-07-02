#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${PROJECT_DIR}/release/pikomin-mac-portable"
PYTHON_BIN="${PYTHON_BIN:-$HOME/.pyenv/versions/3.13.13/bin/python}"

echo "[1/6] Clean output directory..."
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

echo "[2/6] Build frontend..."
VITE_API_URL="http://localhost:5679" corepack pnpm -C "${PROJECT_DIR}/frontend" build

echo "[3/6] Copy project runtime files..."
mkdir -p "${OUT_DIR}/backend" "${OUT_DIR}/frontend" "${OUT_DIR}/docs"
cp -R "${PROJECT_DIR}/backend/app" "${OUT_DIR}/backend/"
cp "${PROJECT_DIR}/backend/requirements.txt" "${OUT_DIR}/backend/"
cp -R "${PROJECT_DIR}/frontend/dist" "${OUT_DIR}/frontend/"
cp "${PROJECT_DIR}/docs/使用手冊_簡易版.md" "${OUT_DIR}/docs/" || true
cp "${PROJECT_DIR}/docs/技術與功能介紹.md" "${OUT_DIR}/docs/" || true
date +"DOC_VERSION=%Y-%m-%d_%H-%M-%S" > "${OUT_DIR}/docs/DOC_VERSION.txt"

echo "[4/6] Create backend virtualenv..."
"${PYTHON_BIN}" -m venv "${OUT_DIR}/venv"
"${OUT_DIR}/venv/bin/python" -m pip install --upgrade pip

# Install runtime deps only (exclude test-only deps).
"${OUT_DIR}/venv/bin/pip" install \
  "fastapi>=0.111.0" \
  "uvicorn[standard]>=0.29.0" \
  "pymobiledevice3>=4.14.0" \
  "httpx>=0.27.0"

echo "[5/6] Create portable launcher..."
cp "${PROJECT_DIR}/scripts/run_portable_mac.command" "${OUT_DIR}/run.command"
chmod +x "${OUT_DIR}/run.command"

cat > "${OUT_DIR}/README.txt" <<'EOF'
Pikomin mac Portable
====================

How to run:
1) Open Terminal in this folder
2) Run: ./run.command

Notes:
- Keep iPhone unlocked while running.
- For iOS 18.2+, tunnel uses TCP and Python 3.13 runtime bundled in this package.
- If macOS blocks execution, allow it from System Settings > Privacy & Security.
EOF

echo "[6/6] Done."
echo "Portable folder: ${OUT_DIR}"
