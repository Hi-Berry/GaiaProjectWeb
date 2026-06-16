@echo off
setlocal
REM ============================================================
REM  Fetch production human game logs (Supabase -> data\human-games)
REM
REM  How to provide the key (either one):
REM   1) Put the key (one line) in scripts\supabase-key.txt  (recommended; git-ignored)
REM   2) Just run this and paste the key when prompted
REM
REM  Key = Render env var SUPABASE_SERVICE_ROLE_KEY (sb_secret_... )
REM ============================================================

REM Move to repo root (this script lives in scripts\)
cd /d "%~dp0.."

REM 1) Use existing env var if present
if not defined SUPABASE_SERVICE_ROLE_KEY (
  REM 2) Read from key file next to this script if present
  if exist "%~dp0supabase-key.txt" (
    set /p SUPABASE_SERVICE_ROLE_KEY=<"%~dp0supabase-key.txt"
  )
)

REM 3) Otherwise prompt for it
if not defined SUPABASE_SERVICE_ROLE_KEY (
  set /p SUPABASE_SERVICE_ROLE_KEY=Paste Supabase service role key, then Enter:
)

if not defined SUPABASE_SERVICE_ROLE_KEY (
  echo.
  echo [!] No key provided. Exiting.
  pause
  exit /b 1
)

echo.
echo Downloading game logs...
node scripts\fetchSupabaseGames.mjs
set EXITCODE=%ERRORLEVEL%

echo.
if "%EXITCODE%"=="0" (
  echo [DONE] Check the data\human-games folder.
) else (
  echo [FAILED] See messages above. Check the key and that Node is installed.
)
echo Press any key to close...
pause >nul
endlocal
