#!/usr/bin/env bash
# Gaia 봇 head2head 실행 래퍼 — 가중치 격리 + 워커6 + 좀비 정리 + 전체 출력 보존.
#
# 사용법:
#   bash run-h2h.sh '{"fedZoneStrategy":true}'        # 기본 120판
#   bash run-h2h.sh '{"qicVpGate":true}' 60           # 60판
#   bash run-h2h.sh '{}'                              # 챔피언 vs 챔피언(종족 평균용 깨끗한 자가대국)
#
# 끝나면 stdout 전체가 보존되므로 scripts/faction-scores.mjs로 종족 평균도 같이 뽑을 수 있다.
# 리포트는 data/h2h-report.json. 판정/승률/VP는 거기 또는 stdout 마지막 '====== 결과 ======' 블록.
set -e
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

# 주의: ${1:-{}} 로 쓰면 bash가 첫 '}'에서 확장을 끊고 마지막 '}'를 리터럴로 붙여
# challenger.flags.json이 '{"x":true}}' 로 깨져 JSON.parse 실패 → {}로 폴백(플래그 미적용).
FLAGS="$1"
[ -z "$FLAGS" ] && FLAGS='{}'
GAMES="${2:-120}"
MCTS="${3:-400}"
WORKERS="${4:-6}"
# 5번째 인자 = 강제 종족(예: geodens). 주면 그 종족을 고정좌석에 앉혀 절반 B(플래그ON)/절반 A(OFF)로 paired 비교.
FORCE_FACTION="${5:-}"

echo "$FLAGS" > server/ai/challenger.flags.json
echo "[run-h2h] challenger flags = $FLAGS | games=$GAMES mcts=${MCTS}ms workers=$WORKERS${FORCE_FACTION:+ | forceFaction=$FORCE_FACTION}"

# 좀비(이전에 중단된 head2head 워커) 정리 — 개발서버(watch)/Cursor는 보존
if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*GaiaProjectWeb*' -and \$_.CommandLine -like '*server/index.ts*' -and \$_.CommandLine -notlike '*watch*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1 || true
fi

# 가중치 격리: 챌린저도 챔피언 가중치 사용 → 플래그만 비교 (weightsDiffer=false 확인할 것)
AI_CHALLENGER_WEIGHTS=server/ai/aiWeights.json \
H2H_GAMES="$GAMES" H2H_MCTS_MS="$MCTS" H2H_WORKERS="$WORKERS" \
H2H_FORCE_FACTION="$FORCE_FACTION" \
  npm run head2head
