@echo off
echo Starting Polygon Middleman Frontend...
cd /d "%~dp0frontend"

if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)

echo Frontend running at http://localhost:5173
npm run dev
