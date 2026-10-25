@echo off
title Ket Noi ClassIn - Port 9222 SAT Sync
color 0b

echo ========================================================
echo   DANG KET NOI CLASSIN VOI CONG REMOTE DEBUGGING 9222...
echo ========================================================
echo.

:: 1. Kiem tra va khoi dong Node Server neu chua chay
netstat -ano | findstr :8899 >nul
if %errorlevel% neq 0 (
  echo [+] Dang khoi dong Node Server tren cong 8899...
  start /b "" node "C:\Users\Administrator\.gemini\antigravity-ide\scratch\classin-pdf-downloader\server.js"
  timeout /t 1 /nobreak >nul
) else (
  echo [v] Node Server dang hoat dong san sang (Port 8899).
)

:: 2. Kiem tra xem ClassIn da co san port 9222 chua
netstat -ano | findstr :9222 >nul
if %errorlevel% equ 0 (
  echo [v] ClassIn da mo va cong 9222 dang ket noi thanh cong!
  goto :DONE
)

:: 3. Kiem tra neu ClassIn dang chay khong co port 9222 thi dong de mo lai
tasklist /fi "imagename eq ClassIn.exe" | findstr /i "ClassIn.exe" >nul
if %errorlevel% equ 0 (
  echo [!] Phat hien ClassIn dang mo chua bat port 9222.
  echo [*] Dang khoi dong lai ClassIn voi port 9222...
  taskkill /f /im ClassIn.exe >nul 2>&1
  taskkill /f /im "ClassIn Helper.exe" >nul 2>&1
  timeout /t 1 /nobreak >nul
)

:: 4. Bat ClassIn voi cong remote debugging 9222
echo [+] Dang bat ClassIn voi port 9222...
start "" "C:\Program Files (x86)\ClassIn\ClassIn.exe" --remote-debugging-port=9222
timeout /t 2 /nobreak >nul

:DONE
netstat -ano | findstr :9222 >nul
if %errorlevel% equ 0 (
  echo.
  echo ========================================================
  echo   [THANH CONG] ClassIn Port 9222 da ket noi san sang!
  echo   Tren trang web http://localhost:8899 den xanh se sang.
  echo ========================================================
) else (
  echo.
  echo [!] ClassIn dang khoi dong, vui long doi vai giay...
)

timeout /t 3
exit
