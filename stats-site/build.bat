@echo off
rem Gaia stats site builder - double-click to rebuild dist/ from current data/human-games
rem (batch files are parsed in the OEM codepage, so keep this file ASCII-only)
cd /d "%~dp0"
rem --local: also builds dist-local (full action logs, local only - never deploy)
node build.mjs --local
echo.
echo Deploy folder: %~dp0dist
echo Local-only folder: %~dp0dist-local
pause
