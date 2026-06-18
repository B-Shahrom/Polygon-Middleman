@echo off
title Polygon Middleman
echo.
echo   +--------------------------------------+
echo   :      Polygon Middleman v1.0          :
echo   +--------------------------------------+
echo.

set "ROOT=%~dp0"

:: Setup backend venv if needed
cd /d "%ROOT%backend"
if not exist "venv" (
    echo   [setup] Creating Python virtual environment...
    python -m venv venv
)

:: Install backend deps silently
call venv\Scripts\activate
pip install -r requirements.txt --quiet 2>nul

:: Install frontend deps if needed
cd /d "%ROOT%frontend"
if not exist "node_modules" (
    echo   [setup] Installing frontend dependencies...
    npm install --silent
)

:: Start backend (hidden window via powershell)
echo   [start] Backend on http://localhost:8000
powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%ROOT%backend\" && call venv\Scripts\activate && uvicorn main:app --host 0.0.0.0 --port 8000 --reload' -WindowStyle Hidden"

:: Wait a moment for backend
timeout /t 3 /nobreak >nul

:: Start frontend (hidden window via powershell)
echo   [start] Frontend on http://localhost:5173
powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%ROOT%frontend\" && npm run dev' -WindowStyle Hidden"

:: Wait for frontend to be ready
timeout /t 4 /nobreak >nul

echo.
echo   Ready! Opening browser...
echo.
echo   Press any key to stop all servers and exit.
echo.

:: Open browser
start "" http://localhost:5173

:: Keep alive
pause >nul

:: Kill server processes by port
echo.
echo   Stopping servers...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":8000.*LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":5173.*LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1
echo   Done.
