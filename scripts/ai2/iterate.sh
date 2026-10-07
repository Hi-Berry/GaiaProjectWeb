#!/usr/bin/env bash
# [ai2 자기 강화 2026-10-06] 반복 1회: ① 이전 모델 PUCT 4좌석 자가대국 ② 이어 학습(자가대국 + 기존 봇 데이터 일부) ③ 대결(PUCT 48 vs 기존 봇)
# 사용: caffeinate -i bash scripts/ai2/iterate.sh <이전 모델 번호> <새 모델 번호> <자가대국 분>   예) bash scripts/ai2/iterate.sh 1 2 270
# 검증·대결 시작 상태는 v1의 val_starts로 고정(자가대국·학습에서 제외) — 반복 간 같은 기준으로 비교.
set -u
cd "$(dirname "$0")/../.."
export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH
PREV=$1; NEXT=$2; MIN=${3:-270}
VAL=data/ai2/model_v1.val_starts.json
LOG=data/ai2/iterate.log; mkdir -p data/ai2/tmp data/ai2/match
say() { echo "[$(date '+%m-%d %H:%M')] $*" | tee -a "$LOG"; }

say "=== 반복 v${PREV} → v${NEXT} ==="
say "① 자가대국: v${PREV} PUCT 48 × 4좌석, 6샤드 × ${MIN}분"
for i in 0 1 2 3 4 5; do
  PORT=$((5171+i)) npx tsx script/ai2SelfPlay.ts --model data/ai2/model_v${PREV}.pt --exclude $VAL --shard $i --shards 6 --sims 48 \
    --minutes $MIN --out data/ai2/selfplay_it${NEXT} > data/ai2/tmp/sp${NEXT}_$i.log 2>&1 &
done; wait
grep -h "완료" data/ai2/tmp/sp${NEXT}_*.log | sed 's/^/   /' | tee -a "$LOG"

say "② v${NEXT} 학습: v${PREV}에서 이어, 자가대국 + 기존 봇 데이터 30%"
python3 -u scripts/ai2/train_ai2.py --data data/ai2/selfplay_it${NEXT} --old data/ai2/selfplay --old-frac 0.3 --init data/ai2/model_v${PREV}.pt \
  --val-starts $VAL --epochs 3 --lr 3e-4 --out data/ai2/model_v${NEXT}.pt > data/ai2/tmp/train_v${NEXT}.log 2>&1
grep -E "행 \(|결정|기준선|ep[0-9]|최고" data/ai2/tmp/train_v${NEXT}.log | sed 's/^/   /' | tee -a "$LOG"

say "③ v${NEXT} 대결: PUCT 48, 검증 시작 상태 × 좌석 2"
rm -f data/ai2/match/puct48_v${NEXT}.jsonl
for off in 0 2; do
  for i in 0 1 2 3 4 5; do
    PORT=$((5160+i)) npx tsx script/ai2Match.ts --mode puct --sims 48 --model data/ai2/model_v${NEXT}.pt --starts $VAL \
      --shard $i --shards 6 --seatOffset $off 2>&1 | grep --line-buffered '"result"' >> data/ai2/match/puct48_v${NEXT}.jsonl &
  done; wait
done
node scripts/ai2/matchReport.mjs data/ai2/match/puct48_v${PREV}.jsonl data/ai2/match/puct48_v${NEXT}.jsonl 2>&1 | sed 's/^/   /' | tee -a "$LOG"
say "=== 끝 ==="
