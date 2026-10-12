#!/usr/bin/env bash
# [ai2 가치망 강화 2026-10-07] ① 가치용 대량 대국(빠른 봇+ε) ② v2 자가대국(루트 Q 기록) ③ v4 학습(가치 목표 = 결과·Q 혼합)
# ④ v4 대결. 학습 로그에 시작(v2)·에포크별 라운드별 가치 상관이 찍힌다 — 가치망이 실제로 좋아졌는지 먼저 본다.
# 사용: caffeinate -i bash scripts/ai2/overnight_value.sh   (로그: data/ai2/iterate.log)
set -u
cd "$(dirname "$0")/../.."
export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH
VAL=data/ai2/model_v1.val_starts.json
LOG=data/ai2/iterate.log; mkdir -p data/ai2/tmp data/ai2/match
say() { echo "[$(date '+%m-%d %H:%M')] $*" | tee -a "$LOG"; }

say "=== 가치망 강화: v2 → v4 ==="
say "① 가치용 대량 대국: 빠른 봇 + ε0.15, 6샤드 × 90분 (30결정당 1행)"
for i in 0 1 2 3 4 5; do
  PORT=$((5181+i)) npx tsx script/ai2ValueGen.ts --shard $i --shards 6 --minutes 90 --eps 0.15 --every 30 --exclude $VAL --out data/ai2/valuegen > data/ai2/tmp/vg_$i.log 2>&1 &
done; wait
grep -h "완료" data/ai2/tmp/vg_*.log | sed 's/^/   /' | tee -a "$LOG"

say "② 자가대국(루트 Q 기록): v2 PUCT 48 × 4좌석, 6샤드 × 180분"
for i in 0 1 2 3 4 5; do
  PORT=$((5171+i)) npx tsx script/ai2SelfPlay.ts --model data/ai2/model_v2.pt --exclude $VAL --shard $i --shards 6 --sims 48 \
    --minutes 180 --out data/ai2/selfplay_it4 > data/ai2/tmp/sp4_$i.log 2>&1 &
done; wait
grep -h "완료" data/ai2/tmp/sp4_*.log | sed 's/^/   /' | tee -a "$LOG"

say "③ v4 학습: v2에서 이어, 자가대국(it2·it3·it4) + 가치용 대국 + 기존 봇 30%, 가치 목표 = 0.5·결과 + 0.5·루트Q(it4)"
python3 -u scripts/ai2/train_ai2.py --data data/ai2/selfplay_it4,data/ai2/selfplay_it3,data/ai2/selfplay_it2 --extra data/ai2/valuegen \
  --old data/ai2/selfplay --old-frac 0.3 --init data/ai2/model_v2.pt --val-starts $VAL --epochs 2 --lr 3e-4 --q-mix 0.5 \
  --out data/ai2/model_v4.pt > data/ai2/tmp/train_v4.log 2>&1
grep -E "행 \(|결정|기준선|시작 모델|ep[0-9]|최고" data/ai2/tmp/train_v4.log | sed 's/^/   /' | tee -a "$LOG"

say "④ v4 대결: PUCT 48, 검증 시작 상태 × 좌석 2"
rm -f data/ai2/match/puct48_v4.jsonl
for off in 0 2; do
  for i in 0 1 2 3 4 5; do
    PORT=$((5160+i)) npx tsx script/ai2Match.ts --mode puct --sims 48 --model data/ai2/model_v4.pt --starts $VAL \
      --shard $i --shards 6 --seatOffset $off 2>&1 | grep --line-buffered '"result"' >> data/ai2/match/puct48_v4.jsonl &
  done; wait
done
node scripts/ai2/matchReport.mjs data/ai2/match/puct48_v2.jsonl data/ai2/match/puct48_v4.jsonl 2>&1 | sed 's/^/   /' | tee -a "$LOG"
say "=== 끝 ==="
