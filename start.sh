#!/usr/bin/env bash
# Polygon Middleman launcher for macOS / Linux (mirror of start.bat).
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "  +--------------------------------------+"
echo "  |      Polygon Middleman v1.0          |"
echo "  +--------------------------------------+"
echo ""

# Pick a Python 3 interpreter
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "  [error] Python 3 not found. Install it and retry." >&2
  exit 1
fi

# Setup backend venv if needed
cd "$ROOT/backend"
if [ ! -d venv ]; then
  echo "  [setup] Creating Python virtual environment..."
  "$PY" -m venv venv
fi
# shellcheck disable=SC1091
source venv/bin/activate
pip install -r requirements.txt --quiet

# Install frontend deps if needed
cd "$ROOT/frontend"
if [ ! -d node_modules ]; then
  echo "  [setup] Installing frontend dependencies..."
  npm install --silent
fi

# Start backend
echo "  [start] Backend on http://localhost:8000"
cd "$ROOT/backend"
uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

sleep 3

# Start frontend
echo "  [start] Frontend on http://localhost:5173"
cd "$ROOT/frontend"
npm run dev &
FRONTEND_PID=$!

# Stop both servers on exit / Ctrl+C
cleanup() {
  echo ""
  echo "  Stopping servers..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  echo "  Done."
}
trap cleanup EXIT INT TERM

sleep 4

# Open the browser (macOS: open, Linux: xdg-open)
URL="http://localhost:5173"
if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
fi

echo ""
echo "  Ready! Press Ctrl+C to stop all servers and exit."
echo ""

# Wait until interrupted
wait
