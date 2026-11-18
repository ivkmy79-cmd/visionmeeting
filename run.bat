@echo off
REM VisionMeeting launcher. ASCII only - see CLAUDE.md.
title VisionMeeting server
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] .venv not found.
  echo   1. python -m venv .venv
  echo   2. .venv\Scripts\pip install -r requirements.txt
  pause
  exit /b 1
)

if not exist ".env" (
  echo [WARN] .env not found. Server starts but Azure translation stays disabled.
  echo        Copy .env.example to .env and set AZURE_CREDENTIALS_FILE.
)

.venv\Scripts\python.exe launcher.py
set "LAUNCH_EXIT=%ERRORLEVEL%"
pause
exit /b %LAUNCH_EXIT%
