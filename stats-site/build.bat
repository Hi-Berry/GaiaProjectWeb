@echo off
rem Gaia stats site builder - double-click to rebuild dist/ from current data/human-games
rem (batch files are parsed in the OEM codepage, so keep this file ASCII-only)
cd /d "%~dp0"
node build.mjs
echo.
echo Output folder: %~dp0dist
pause
