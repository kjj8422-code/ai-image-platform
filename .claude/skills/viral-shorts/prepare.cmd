@echo off
rem 모든 .bat이 맨 처음 부르는 준비 단계. 파이썬이 있는지 보고, 필요한 패키지가
rem 빠졌거나 업데이트로 바뀌었으면 알아서 설치한다. 문제가 있으면 1을 돌려준다.
rem   call ".claude\skills\viral-shorts\prepare.cmd"        (쇼츠 도구만)
rem   call ".claude\skills\viral-shorts\prepare.cmd" --web  (웹 패키지도)

rem "where python"만 보면 안 된다. 윈도우에는 파이썬이 없어도 python을 치면
rem 스토어를 여는 가짜 실행 파일이 있어서, 실제로 한 줄 돌려 봐야 안다.
python -c "import sys" >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [!] 이 PC에 파이썬이 없어요. 자동으로 설치해 볼게요...
    where winget >nul 2>nul
    if errorlevel 1 goto :no_winget
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    echo.
    echo   설치가 끝났으면 이 창을 닫고 방금 실행한 파일을 다시 실행해 주세요.
    echo   ^(새로 설치한 파이썬은 새 창에서부터 인식돼요^)
    exit /b 1
)

python "%~dp0ensure_deps.py" %*
exit /b %errorlevel%

:no_winget
echo.
echo   자동 설치 도구가 없어서 직접 설치가 필요해요.
echo   1. https://www.python.org/downloads/ 에서 Python을 내려받아 설치
echo   2. 설치 첫 화면에서 "Add python.exe to PATH" 체크 꼭 하기
echo   3. 이 파일을 다시 실행
exit /b 1
