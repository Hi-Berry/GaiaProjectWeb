#!/bin/bash
# ============================================================
#  운영 서버 사람 게임 로그 받기 (Supabase -> data/human-games) — 맥용
#  윈도 fetch-supabase-games.bat 와 같은 일을 한다.
#
#  실행: 파인더에서 이 파일을 더블클릭하거나, 터미널에서  bash scripts/fetch-supabase-games.command
#
#  키 넣는 법(둘 중 하나):
#   1) scripts/supabase-key.txt 에 키 한 줄 (권장 — 깃에 안 올라간다)
#   2) 그냥 실행하고 물어볼 때 붙여넣기 (화면에 안 보인다)
#  키 = Render 환경변수 SUPABASE_SERVICE_ROLE_KEY (sb_secret_...)
# ============================================================

# 저장소 루트로 이동 (이 파일은 scripts/ 안에 있다)
cd "$(dirname "$0")/.." || exit 1

# 노드 — 터미널 설정에 따라 PATH 에 없을 수 있어 nvm 을 먼저 불러 본다
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
if ! command -v node >/dev/null 2>&1; then
  echo "[!] node 를 찾지 못했습니다. Node 18 이상을 설치해 주세요."
  read -r -p "엔터를 누르면 닫힙니다..." _
  exit 1
fi

# 1) 이미 환경변수에 있으면 그대로  2) 키 파일  3) 직접 붙여넣기
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ] && [ -f scripts/supabase-key.txt ]; then
  SUPABASE_SERVICE_ROLE_KEY="$(head -n 1 scripts/supabase-key.txt | tr -d '\r\n ')"
fi
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  read -r -s -p "Supabase 서비스 키를 붙여넣고 엔터: " SUPABASE_SERVICE_ROLE_KEY
  echo
fi
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "[!] 키가 없어 끝냅니다."
  read -r -p "엔터를 누르면 닫힙니다..." _
  exit 1
fi
export SUPABASE_SERVICE_ROLE_KEY

echo
echo "게임 로그 받는 중..."
node scripts/fetchSupabaseGames.mjs
code=$?

echo
if [ "$code" -eq 0 ]; then
  echo "[완료] data/human-games 폴더를 확인하세요."
else
  echo "[실패] 위 메시지를 확인하세요. 키와 node 설치를 확인하세요."
fi
# 터미널에서 직접 돌렸을 땐 바로 끝나고, 더블클릭으로 열린 창일 땐 결과를 볼 수 있게 기다린다
[ -t 0 ] && read -r -p "엔터를 누르면 닫힙니다..." _
exit $code
