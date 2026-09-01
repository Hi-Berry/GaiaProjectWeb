@echo off
rem 가이아 통계 사이트 빌드 — 더블클릭하면 현재 data/human-games 자료로 dist/에 페이지 생성
chcp 65001 >nul
cd /d "%~dp0"
node build.mjs
echo.
echo 결과 폴더: %~dp0dist
pause
