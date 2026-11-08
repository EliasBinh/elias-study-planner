@echo off
chcp 65001 >nul
title Scribd PDF Downloader Server
cd /d "%~dp0"

echo ===================================================
echo     KHOI DONG SCRIBD PDF DOWNLOADER (PORT 5050)
echo ===================================================
echo.

:: Kill old instances on port 5050 if any
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5050 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

echo [1/2] Dang chay Web Server (Port 5050)...
start /b python scribd-web\app.py

timeout /t 2 >nul

echo [2/2] Dang mo duong link online https://elias-study-scribd-downloader.loca.lt ...
npx localtunnel --port 5050 --subdomain elias-study-scribd-downloader

pause
