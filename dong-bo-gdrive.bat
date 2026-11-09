@echo off
chcp 65001 >nul
title Dong Bo Google Drive - Elias Study
cd /d "%~dp0"
echo ========================================================
echo   DONG BO TAI LIEU GOOGLE DRIVE VAO HE THONG ELIAS STUDY
echo ========================================================
python dong-bo-gdrive.py
echo.
echo Nhan phim bat ky de thoat...
pause >nul

