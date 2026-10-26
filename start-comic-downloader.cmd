@echo off
setlocal
cd /d "%~dp0"
set "NODE_OPTIONS="
echo.
echo   Starting Zhijian comic downloader...
echo.
node tools\comic-downloader\server.mjs
if errorlevel 1 pause
