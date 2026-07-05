#!/usr/bin/env bash
# Start the Polygon Middleman backend on macOS / Linux.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")/backend"

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "Python 3 not found. Install it and retry." >&2
  exit 1
fi

if [ ! -d venv ]; then
  echo "Creating virtual environment..."
  "$PY" -m venv venv
fi
# shellcheck disable=SC1091
source venv/bin/activate
pip install -r requirements.txt --quiet

echo "Backend running at http://localhost:8000"
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
