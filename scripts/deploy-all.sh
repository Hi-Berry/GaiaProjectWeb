#!/usr/bin/env bash
# 3개 Render 인스턴스 일괄 배포 — 각 서비스의 Deploy Hook URL을 호출 (로그인 불필요).
# 훅 URL은 비밀이라 repo에 안 넣음: 프로젝트 루트의 .render-hooks (git 무시됨)에 한 줄씩.
#   서버1이름 https://api.render.com/deploy/srv-xxxx?key=yyyy
#   서버2이름 https://api.render.com/deploy/srv-xxxx?key=yyyy
# 훅 URL 위치: 각 Render 서비스 → Settings → Deploy Hook
set -e
cd "$(git rev-parse --show-toplevel)"
HOOKS_FILE=".render-hooks"
if [ ! -f "$HOOKS_FILE" ]; then
  echo "❌ $HOOKS_FILE 없음. 각 Render 서비스 Settings → Deploy Hook URL을 복사해"
  echo "   '이름 URL' 형식으로 한 줄씩 넣어줘 (파일은 git에 안 올라감)."
  exit 1
fi
while read -r name url; do
  [ -z "$name" ] && continue
  case "$name" in \#*) continue;; esac
  printf "%-12s → " "$name"
  code=$(curl -s -o /dev/null -w "%{http_code}" --ssl-no-revoke -X POST "$url" || echo ERR)
  [ "$code" = "200" ] || [ "$code" = "201" ] && echo "배포 트리거됨 ($code)" || echo "실패 ($code)"
done < "$HOOKS_FILE"
echo "완료 — 각 서비스 빌드는 3~8분 소요. 확인: curl <서버주소>/api/status"
