@echo off
REM VisionMeeting - open the meeting page only. ASCII only - see CLAUDE.md.
REM Never starts the server. Start the server with run.bat, stop it with stop.bat.
title VisionMeeting
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0program.ps1" %*
set "PROGRAM_EXIT=%ERRORLEVEL%"
if not "%PROGRAM_EXIT%"=="0" pause
exit /b %PROGRAM_EXIT%
