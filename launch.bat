@echo off
title Elias Minimalist Workspace

:: 1. Kiem tra xem Node Server da chay tren cong 8899 chua, neu chua thi khoi dong ngam
netstat -ano | findstr :8899 >nul
if %errorlevel% neq 0 (
  start /b "" node "C:\Users\Administrator\.gemini\antigravity-ide\scratch\classin-pdf-downloader\server.js"
  timeout /t 1 /nobreak >nul
)

:: 2. Mo giao dien Chrome App Mode (HOAN TOAN KHONG MO CLASSIN)
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:8899 --window-size=1400,860
exit
