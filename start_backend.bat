@echo off
echo Starting Polygon Middleman Backend...
cd /d "%~dp0backend"

if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

call venv\Scripts\activate
pip install -r requirements.txt --quiet

echo Backend running at http://localhost:8000
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
