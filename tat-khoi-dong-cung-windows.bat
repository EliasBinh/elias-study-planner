@echo off
chcp 65001 >nul
echo =======================================================
echo   TẮT TỰ KHỞI ĐỘNG CÙNG WINDOWS (DISCORD RPC)
echo =======================================================
echo.

set "TARGET_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EliasDiscordRPC.vbs"

if exist "%TARGET_VBS%" (
  del /f /q "%TARGET_VBS%"
  echo [THÀNH CÔNG] Đã xóa khỏi thư mục Startup của Windows.
  echo Máy tính sẽ không còn tự chạy Discord RPC khi khởi động nữa.
) else (
  echo [THÔNG BÁO] Hiện tại chưa bật tự khởi động cùng Windows.
)

echo.
pause
