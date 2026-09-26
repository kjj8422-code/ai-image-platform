@echo off
chcp 65001 >nul
cd /d "%~dp0"
call ".claude\skills\viral-shorts\prepare.cmd"
if errorlevel 1 goto :end
if "%~1"=="" (
    python ".claude\skills\viral-shorts\audio_library_sync.py" --watch
) else (
    python ".claude\skills\viral-shorts\audio_library_sync.py" --connect "%~1" --watch
)
:end
pause
