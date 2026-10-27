@echo off
cd /d "%~dp0..\.."
node scripts\connect-ngrok.cjs
pause
