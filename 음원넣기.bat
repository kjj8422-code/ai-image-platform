@echo off
chcp 65001>nul
setlocal
cd /d "%~dp0"

echo.
echo   =====================================
echo     음원 넣기 (효과음 / 배경음악)
echo   =====================================
echo.
echo   무료 사이트에서 받은 소리를 쇼츠에서 고를 수 있는 칸에 넣습니다.
echo   받은 파일을 이 아이콘 위에 끌어다 놓아도 됩니다.

rem 파일을 끌어다 놓으면 %1 로 들어온다. 그 파일을 바로 넣고, 아니면 메뉴를 띄운다.
if "%~1"=="" (
    python ".claude\skills\viral-shorts\import_audio.py"
) else (
    python ".claude\skills\viral-shorts\import_audio.py" "%~1"
)

if errorlevel 1 (
    echo.
    echo   [!] 문제가 생겼습니다. 위에 나온 글씨를 그대로 알려주세요.
)
echo.
pause
