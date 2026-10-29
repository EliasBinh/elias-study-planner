@echo off
chcp 65001 >nul
echo =======================================================
echo   CÀI ĐẶT TỰ ĐỘNG CHẠY NGẦM DISCORD RPC CÙNG WINDOWS
echo =======================================================
echo.

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET_VBS=%STARTUP_DIR%\EliasDiscordRPC.vbs"
set "SCRIPT_DIR=%~dp0"

echo Dang tao file khoi dong tai:
echo %TARGET_VBS%
echo.

(
  echo Set WshShell = CreateObject^("WScript.Shell"^)
  echo WshShell.CurrentDirectory = "%SCRIPT_DIR:~0,-1%"
  echo WshShell.Run "node server.js", 0, False
) > "%TARGET_VBS%"

if exist "%TARGET_VBS%" (
  echo [THÀNH CÔNG] Đã bật tự khởi động cùng Windows!
  echo Mỗi khi bật máy tính, Discord RPC sẽ tự động chạy ngầm.
  echo Bạn chỉ cần vào web Render ^(https://elias-study-planner.onrender.com^)
  echo để học mà không cần mở bất kỳ trang web localhost nào.
  echo.
  echo Đang khởi chạy ngầm ngay bây giờ...
  wscript.exe "%TARGET_VBS%"
  echo [OK] Đã chạy ngầm xong!
) else (
  echo [LỖI] Không thể tạo file trong thư mục Startup!
)

echo.
pause
