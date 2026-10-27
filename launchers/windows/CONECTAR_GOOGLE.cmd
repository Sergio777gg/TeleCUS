@echo off
cd /d "%~dp0..\.."
node scripts\connect-google.cjs --open
pause
