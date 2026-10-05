#!/usr/bin/env bash
# [ai2 2026-10-05] 밤샘 파이프라인: ① 시작 상태 확대(h2h 300판, R1 스냅샷) ② 기존 봇 자가대국 데이터 ③ v1 학습 ④ v1 대결
# 사용: caffeinate -i bash scripts/ai2/overnight.sh   (로그: data/ai2/overnight.log)
set -u
cd "$(dirname "$0")/../.."
export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH
LOG=data/ai2/overnight.log; mkdir -p data/ai2/match data/ai2/tmp
say() { echo "[$(date '+%m-%d %H:%M')] $*" | tee -a "$LOG"; }
echo '{}' > data/ai2/tmp/empty.json

say "① 시작 상태 확대: h2h 300판 (MCTS 50ms, R1 스냅샷 덤프) — 현재 $(ls logs/round-start/*_r1.json | wc -l)개"
AI_ROUND_START_SNAPSHOTS=1 AI_CHALLENGER_FLAGS=data/ai2/tmp/empty.json AI_CHALLENGER_WEIGHTS=server/ai/aiWeights.json \
  H2H_BASE_PORT=5330 H2H_REPORT=data/ai2/tmp/starts-report.json H2H_GAMES=300 H2H_MCTS_MS=50 H2H_WORKERS=6 \
  npm run head2head > data/ai2/tmp/starts.log 2>&1
say "   → R1 시작 상태 $(ls logs/round-start/*_r1.json | wc -l)개"

say "② 자가대국 데이터: 6샤드 × 시작당 5판 (MCTS 200ms)"
for i in 0 1 2 3 4 5; do
  PORT=$((5141+i)) npx tsx script/ai2GenData.ts --shard $i --shards 6 --mcts 200 --reps 5 --out data/ai2/selfplay > data/ai2/tmp/gen$i.log 2>&1 &
done; wait
grep -h "완료" data/ai2/tmp/gen*.log | sed 's/^/   /' | tee -a "$LOG"
say "   → 데이터 $(du -sh data/ai2/selfplay | cut -f1)"

say "③ v1 학습 (4에포크, 에포크마다 최고 모델 저장)"
python3 -u scripts/ai2/train_ai2.py --data data/ai2/selfplay --epochs 4 --out data/ai2/model_v1.pt > data/ai2/tmp/train_v1.log 2>&1
grep -E "결정|기준선|ep[0-9]|최고" data/ai2/tmp/train_v1.log | sed 's/^/   /' | tee -a "$LOG"

say "④ v1 대결: 학습에 안 쓴 시작 상태 × 좌석 2 (greedy, search)"
for MODE in greedy search; do
  rm -f data/ai2/match/${MODE}_v1.jsonl
  for off in 0 2; do
    for i in 0 1 2 3 4 5; do
      PORT=$((5160+i)) npx tsx script/ai2Match.ts --mode $MODE --model data/ai2/model_v1.pt --starts data/ai2/model_v1.val_starts.json \
        --shard $i --shards 6 --seatOffset $off 2>&1 | grep --line-buffered '"result"' >> data/ai2/match/${MODE}_v1.jsonl &
    done; wait
  done
done
node scripts/ai2/matchReport.mjs data/ai2/match/greedy_v1.jsonl data/ai2/match/search_v1.jsonl 2>&1 | sed 's/^/   /' | tee -a "$LOG"
say "끝"
