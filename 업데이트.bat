@echo off
chcp 65001>nul
setlocal
cd /d "%~dp0"

echo.
echo   =====================================
echo     최신 버전으로 업데이트
echo   =====================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo   [!] git이 없어서 자동으로 받을 수 없어요.
    echo       https://git-scm.com/download/win 에서 설치한 뒤 다시 실행해 주세요.
    goto :install
)
if not exist ".git" (
    echo   [!] 이 폴더는 git으로 받은 폴더가 아니라서 자동 업데이트를 건너뛰어요.
    goto :install
)

rem 사이트에 올라간 버전(main)을 받는다. 각자 PC에 넣은 음원(assets\user)과
rem 로그인 정보(.env)는 git이 건드리지 않는 파일이라 그대로 남는다.
echo   최신 코드를 받는 중...
git pull --ff-only origin main
if errorlevel 1 (
    echo.
    echo   [!] 받아오지 못했어요. 이 폴더에서 파일을 직접 고친 적이 있으면 생기는 문제예요.
    echo       위에 나온 글씨를 그대로 알려주세요.
    echo.
    pause
    exit /b 1
)

:install
echo.
call ".claude\skills\viral-shorts\prepare.cmd" --web
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)
echo.
echo   ✔ 업데이트 완료! 이제 쇼츠만들기.bat 등을 평소처럼 쓰시면 돼요.
echo.
pause
