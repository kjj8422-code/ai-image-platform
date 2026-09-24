@echo off
chcp 65001>nul
setlocal
cd /d "%~dp0"

echo.
echo   =====================================
echo     영상 받기 (인스타 / 유튜브 / 틱톡)
echo   =====================================
echo.
echo   영상 링크를 붙여 넣으면 out\reference 폴더에 받아 둬요.
echo   받은 영상은 영상으로쇼츠.bat에 끌어다 놓으면 쇼츠로 만들 수 있어요.
echo.

call ".claude\skills\viral-shorts\prepare.cmd"
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)

python ".claude\skills\viral-shorts\video_download.py" %*

if exist "out\reference" start "" explorer "%CD%\out\reference"
echo.
pause
