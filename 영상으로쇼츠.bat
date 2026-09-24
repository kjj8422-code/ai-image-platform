@echo off
chcp 65001>nul
setlocal
cd /d "%~dp0"

echo.
echo   =====================================
echo     영상으로 쇼츠 만들기
echo   =====================================
echo.
echo   영상 파일을 이 아이콘 위에 끌어다 놓으면 쇼츠 모양으로 만들어요.
echo   (위: 제목 / 가운데: 원본 영상 / 아래: 자막)
echo.

call ".claude\skills\viral-shorts\prepare.cmd"
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)

if "%~1"=="" (
    python ".claude\skills\viral-shorts\clip_shorts.py"
) else (
    python ".claude\skills\viral-shorts\clip_shorts.py" "%~1"
)

if errorlevel 1 (
    echo.
    echo   [!] 문제가 생겼습니다. 위에 나온 글씨를 그대로 알려주세요.
) else (
    if exist "out\clips" start "" explorer "%CD%\out\clips"
)
echo.
pause
