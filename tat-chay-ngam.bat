@echo off
chcp 65001 >nul
echo Dang tat tien trinh chay ngam Elias Discord RPC (Port 8899)...

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8899 ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)

echo [OK] Đã tắt tiến trình chạy ngầm.
timeout /t 2 >nul
