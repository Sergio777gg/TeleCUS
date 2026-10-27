@echo off
cd /d "%~dp0..\.."
node scripts\mode.cjs demo
if errorlevel 1 (pause & exit /b 1)
start "" "http://localhost:5173"
