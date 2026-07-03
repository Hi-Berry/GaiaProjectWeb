#!/usr/bin/env bash
# 봇 강도 추적 — 현재봇(채택 플래그 기본 ON) vs 베이스라인(BASELINE_OFF 플래그를 OFF로 = 이전 봇) A/B.
# 결과 "날짜: 현재 X vs 베이스 Y → +Z VP (N판)" 를 data/strength-log.md 에 누적 append.
# 사용법: bash scripts/strengthTrack.sh [games] [label]
#   games: 판수(기본 120). label: 로그에 붙일 메모(기본 오늘날짜).
set -e
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

GAMES="${1:-120}"
LABEL="${2:-$(date +%F)}"

# 베이스라인 = "이 플래그들을 OFF로 돌린 봇"(= 채택 전 봇). 새 채택이 생기면 여기 추가해 같은 기준 유지.
BASELINE_OFF='{"gaiaBoosterUsable":false,"lantidsEarlyPI":false,"pendingStepsPreferFull":false,"itarsBurnCandidate":false,"noFedTierUp":false,"noBuildAdjFed":false,"firaksLabLock":false,"rebellionMineSelect":false,"researchValueModel":false}'

echo "[strengthTrack] $LABEL | games=$GAMES | baseline OFF = $BASELINE_OFF"

# 좀비 워커 정리(watch 개발서버 보존)
if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*GaiaProjectWeb*' -and \$_.CommandLine -like '*server/index.ts*' -and \$_.CommandLine -notlike '*watch*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1 || true
fi

# 도전자(B)=베이스라인(플래그 OFF), 챔피언(A)=현재봇(기본 ON). 가중치 격리.
echo "$BASELINE_OFF" > server/ai/challenger.flags.json
OUT="data/strength-run.log"
AI_CHALLENGER_WEIGHTS=server/ai/aiWeights.json \
H2H_GAMES="$GAMES" H2H_MCTS_MS=400 H2H_WORKERS=6 \
  npm run head2head > "$OUT" 2>&1 || true

echo '{}' > server/ai/challenger.flags.json  # 원복

# 파싱: "평균 VP: 챔피언 X vs 도전자 Y" (챔피언=현재, 도전자=베이스라인). 현재−베이스 = 개선폭.
node -e '
const fs=require("fs");
const t=fs.readFileSync("data/strength-run.log","utf8");
const m=t.match(/평균 VP: 챔피언 ([\d.]+) vs 도전자 ([\d.]+)/);
const g=t.match(/완료 게임: (\d+)/);
if(!m){ console.log("파싱 실패 — data/strength-run.log 확인"); process.exit(0); }
const cur=parseFloat(m[1]), base=parseFloat(m[2]), delta=(cur-base).toFixed(2), games=g?g[1]:"?";
const label=process.argv[1];
const line=`| ${label} | ${cur.toFixed(1)} | ${base.toFixed(1)} | ${delta>=0?"+":""}${delta} | ${games} |`;
const path="data/strength-log.md";
let head="";
if(!fs.existsSync(path)) head="# 봇 강도 추적 (현재봇 vs 베이스라인=오늘 채택분 OFF)\n\n_현재=채택 플래그 ON, 베이스=OFF. Δ>0 = 그만큼 강해짐. 베이스라인은 채택 누적될수록 더 과거 봇._\n\n| 날짜/라벨 | 현재 | 베이스 | Δ VP | 판수 |\n|--|--|--|--|--|\n";
fs.appendFileSync(path, (head||"") + line + "\n");
console.log("\n=== 강도 추적 ===");
console.log(`${label}: 현재 ${cur.toFixed(1)} vs 베이스 ${base.toFixed(1)} → ${delta>=0?"+":""}${delta} VP (${games}판)`);

// 종족별 (A=현재/챔피언, B=베이스/도전자). 게임 줄에서 A:fac=score / B:fac=score 파싱.
const facCur={}, facBase={};
for (const p of t.split(/[|\n]/)) {
  const mm = p.match(/\b([AB]):([a-z_]+)=(\d+)/);
  if (!mm) continue;
  const bucket = mm[1] === "A" ? facCur : facBase;
  (bucket[mm[2]] = bucket[mm[2]] || []).push(parseInt(mm[3], 10));
}
const avg = a => a && a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
const facs = Array.from(new Set([...Object.keys(facCur), ...Object.keys(facBase)])).sort();
const rows = facs.map(f => {
  const c = avg(facCur[f]), b = avg(facBase[f]);
  const d = (c!=null && b!=null) ? (c-b) : null;
  return { f, c, b, d, nc:(facCur[f]||[]).length, nb:(facBase[f]||[]).length };
}).filter(r => r.d!=null).sort((a,b)=>a.d-b.d);
let block = `\n### ${label} 종족별 (현재 vs 베이스, Δ 낮은순)\n\n| 종족 | 현재 | 베이스 | Δ | n(현재/베이스) |\n|--|--|--|--|--|\n`;
for (const r of rows) block += `| ${r.f} | ${r.c.toFixed(1)} | ${r.b.toFixed(1)} | ${r.d>=0?"+":""}${r.d.toFixed(1)} | ${r.nc}/${r.nb} |\n`;
fs.appendFileSync(path, block);
console.log("종족별 Δ:", rows.map(r=>`${r.f}${r.d>=0?"+":""}${r.d.toFixed(1)}`).join(" "));
console.log("→ data/strength-log.md 에 전체+종족별 누적됨");
' "$LABEL"
