@echo off
cd /d "%~dp0..\.."
node scripts\check-google.cjs
pause
