@echo off
cd /d "%~dp0..\.."
node "%cd%\scripts\start-ngrok.cjs"
if errorlevel 1 (pause & exit /b 1)
