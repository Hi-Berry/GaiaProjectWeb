@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM ============================================================
REM  프로덕션 휴먼 게임 로그 받아오기 (Supabase -> data\human-games)
REM
REM  키 넣는 방법 (둘 중 하나):
REM   1) 이 bat 옆에 supabase-key.txt 파일을 만들고 키 한 줄만 저장(권장, git 무시됨)
REM   2) 그냥 실행하면 키를 물어봄 (붙여넣기)
REM
REM  키는 Render 환경변수 SUPABASE_SERVICE_ROLE_KEY (sb_secret_... 형식)
REM ============================================================

REM 레포 루트로 이동 (이 스크립트는 scripts\ 안에 있음)
cd /d "%~dp0.."

REM 1) 환경변수에 이미 있으면 그대로 사용
if not defined SUPABASE_SERVICE_ROLE_KEY (
  REM 2) 옆에 키 파일이 있으면 거기서 읽기
  if exist "%~dp0supabase-key.txt" (
    set /p SUPABASE_SERVICE_ROLE_KEY=<"%~dp0supabase-key.txt"
  )
)

REM 3) 그래도 없으면 직접 입력받기
if not defined SUPABASE_SERVICE_ROLE_KEY (
  set /p SUPABASE_SERVICE_ROLE_KEY=Supabase service role key 입력 후 Enter:
)

if not defined SUPABASE_SERVICE_ROLE_KEY (
  echo.
  echo [!] 키가 없어서 종료합니다.
  pause
  exit /b 1
)

echo.
echo 게임 로그 받아오는 중...
node scripts\fetchSupabaseGames.mjs
set EXITCODE=%ERRORLEVEL%

echo.
if "%EXITCODE%"=="0" (
  echo [완료] data\human-games 폴더를 확인하세요.
) else (
  echo [실패] 위 메시지를 확인하세요. (키가 맞는지, node 설치됐는지)
)
echo 아무 키나 누르면 창이 닫힙니다.
pause >nul
endlocal
