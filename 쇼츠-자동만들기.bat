@echo off
chcp 65001>nul
cd /d "%~dp0"
title 쇼츠 자동 제작
python ".claude\skills\viral-shorts\watch_downloads.py"
echo.
pause
