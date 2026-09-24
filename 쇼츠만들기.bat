@echo off
chcp 65001>nul
setlocal
cd /d "%~dp0"

echo.
echo   =====================================
echo     쇼츠 만들기
echo   =====================================
echo.

call ".claude\skills\viral-shorts\prepare.cmd"
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)

rem 다운로드 폴더에서 가장 최근에 받은 프로젝트 파일을 고른다.
rem 브라우저는 같은 파일을 또 받으면 "shorts-project (1).json" 처럼 이름을 바꿔
rem 저장한다. 파일명을 고정해두면 그런 줄 모르고 계속 옛날 대본으로 영상을 뽑게
rem 되므로, 이름이 아니라 받은 시각으로 고른다.
set "PROJ="
for /f "delims=" %%F in ('dir /b /o-d "%USERPROFILE%\Downloads\shorts-project*.json" 2^>nul') do (
    if not defined PROJ set "PROJ=%USERPROFILE%\Downloads\%%F"
)

if not defined PROJ (
    echo   [!] 다운로드 폴더에 프로젝트 파일이 없습니다.
    echo.
    echo       웹사이트 /shorts 에서 사진을 올리고
    echo       [프로젝트 파일 내려받기] 를 먼저 눌러주세요.
    echo.
    pause
    exit /b 1
)

echo   대본 파일 : %PROJ%

rem 결과는 실행할 때마다 새 폴더에 담는다. 같은 폴더에 다시 쓰면 예전 음성과
rem 이미지를 재사용해서 고친 내용이 반영되지 않고, 그렇다고 지워버리면 전에 만든
rem 영상까지 날아간다. 시각을 붙인 폴더를 쓰면 둘 다 피할 수 있다.
for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%T"
set "OUTDIR=out\%STAMP%"
echo   저장 위치 : %OUTDIR%
echo.

python ".claude\skills\viral-shorts\build_shorts.py" --project "%PROJ%" --out-dir "%OUTDIR%"

if errorlevel 1 (
    echo.
    echo   [!] 만드는 중에 문제가 생겼습니다.
    echo       위에 빨간 글씨가 있으면 그대로 알려주세요.
    echo.
    pause
    exit /b 1
)

echo.
echo   완성했습니다. 폴더를 엽니다.
start "" explorer "%CD%\%OUTDIR%"
echo.
pause
