#!/usr/bin/env bash
# Start the Polygon Middleman frontend on macOS / Linux.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")/frontend"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Frontend running at http://localhost:5173"
npm run dev
