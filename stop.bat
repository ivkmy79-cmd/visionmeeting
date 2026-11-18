@echo off
REM VisionMeeting server stop. ASCII only - see CLAUDE.md.
title VisionMeeting stop
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
set "STOP_EXIT=%ERRORLEVEL%"
pause
exit /b %STOP_EXIT%
