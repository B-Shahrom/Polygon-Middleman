@echo off
title Polygon Middleman
echo.
echo   ╔══════════════════════════════════════╗
echo   ║      Polygon Middleman v1.0         ║
echo   ╚══════════════════════════════════════╝
echo.

:: Setup backend venv if needed
cd /d "%~dp0backend"
if not exist "venv" (
    echo [setup] Creating Python virtual environment...
    python -m venv venv
)

:: Install backend deps silently
call venv\Scripts\activate
pip install -r requirements.txt --quiet 2>nul

:: Install frontend deps if needed
cd /d "%~dp0frontend"
if not exist "node_modules" (
    echo [setup] Installing frontend dependencies...
    npm install --silent
)

:: Start backend in background (minimized)
echo [start] Backend starting on port 8000...
start /min "Polygon-Backend" cmd /c "cd /d "%~dp0backend" && call venv\Scripts\activate && uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

:: Wait a moment for backend
timeout /t 2 /nobreak >nul

:: Start frontend in background (minimized)
echo [start] Frontend starting on port 5173...
start /min "Polygon-Frontend" cmd /c "cd /d "%~dp0frontend" && npm run dev"

:: Wait for frontend to be ready
timeout /t 4 /nobreak >nul

echo.
echo   Ready! Opening http://localhost:5173
echo.
echo   Backend:  http://localhost:8000
echo   Frontend: http://localhost:5173
echo.
echo   Close this window to stop both servers.
echo.

:: Open browser
start http://localhost:5173

:: Keep alive — press Ctrl+C or close window to stop
echo   Press any key to stop both servers...
echo.
pause >nul

:: Kill background server windows
taskkill /FI "WINDOWTITLE eq Polygon-Backend" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Polygon-Frontend" /T /F >nul 2>&1
echo   Servers stopped.
