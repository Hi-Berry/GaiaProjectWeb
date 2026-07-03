# AI 봇 강화 — 다른 컴/주말 이어하기 가이드

브랜치: **`ai-bot-reliability-and-measurement`** (배포도 이 브랜치). node ≥ v20 (개발기 v24).

## 세팅 (다른 컴)
```bash
git clone <repo> && cd GaiaProjectWeb
git checkout ai-bot-reliability-and-measurement
git pull                     # 최신 커밋 (푸시는 쓰기권한 있는 계정에서)
npm install
```

## 핵심 명령
```bash
# 1) A/B 한 플래그 검증 (챔피언=현재 default ON vs 도전자=그 플래그 OFF)
echo '{"FLAG": false}' > server/ai/challenger.flags.json
AI_CHALLENGER_WEIGHTS=server/ai/aiWeights.json \
  H2H_GAMES=60 H2H_MCTS_MS=400 H2H_WORKERS=6 H2H_GAME_TIMEOUT_MIN=3 \
  npm run head2head
echo '{}' > server/ai/challenger.flags.json      # 원복 필수

# 2) 매일 누적 강도추적 (현재봇 vs 예전봇=BASELINE_OFF 전부 OFF) → data/strength-log.md 누적
bash scripts/strengthTrack.sh 120

# 3) 사람 파워 운영 분석
node scripts/analyzeHumanPower.mjs
```

## ⚠️ 꼭 지킬 것 (안 그러면 삽질)
- **`H2H_GAME_TIMEOUT_MIN=3` 항상 붙이기.** 기본이 35분/게임이라, 스톨 게임 하나가 35분 버텨서 "안 끝남". 3분 캡이면 걸린 게임만 실패 처리하고 완주 → 최종 요약+행동표 출력됨.
- **배치 전 좀비 node 정리** (스톨 원인):
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like '*GaiaProjectWeb*' -and $_.CommandLine -notlike '*watch*' } | % { Stop-Process -Id $_.ProcessId -Force }`
- **동시에 head2head 두 개 돌리지 말 것** (CPU 경합 → 둘 다 스톨).
- **VP만 보지 말고 행동 지표 확인** — 코드 넣어도 MCTS 행동이 안 바뀌면 헛것. head2head 끝에 행동믹스 표(파워액션·midP3·경제상승R4+·2Q가이아·연구소 등) 나옴. "넣었더니 실제로 이렇게 달라졌다"를 봐야 함.

## 지금까지 (2026-07-03)
**채택/유지**: rebellionMineSelect(+2.41), researchValueModel(wash·유지), navBeforeJumpSoon, fedSpendBowl3
**기각**: powerHoardDamp(행동무변+VP−2.8), pendingTechTileValue(행동무변·do-no-harm ON유지)
자세한 건 `data/strength-log.md`, `.claude/skills/gaia-ai-lab/DECISIONS.md`.

## 열린 작업 (다음 레버)
1. **파워 격차 = 파워액션 사용량(봇 3.1 vs 사람 4.9)**, 막라 bowl3 아님(둘 다 ~0.4).
   → head2head 돌려 **midP3(게임내내 평균 bowl3)·charge(충전)** 확인:
   - midP3 낮음+파워액션 적음 = **공급부족**(충전/leech 안함) → 레버=배치/충전
   - midP3 높음+파워액션 적음 = **소비부족**(있는데 안씀) → 레버=파워액션 후보/가치
   (사람 midP3 ~1.5. 봇 숫자 이 런에서 처음 나옴.)
2. **종족 hang 버그**: 측정 스톨이 특정 종족 무한루프 의심(아이타 PI교환류). head2head에 `[HANG]` 진단 있음 — 타임아웃 시 `turn=종족 pending=[...]` 찍힘. 여러 판 돌려 패턴 잡기.
3. **다턴 지능은 하드코딩 목표 X → 평가기 옵션가치 개선** 노선(단 작은 항 추가는 행동 잘 안 바뀜 확인됨 — 결정경로/후보측 병행 필요).

## 기억 안 따라오는 것
- Claude의 프로젝트 memory는 이 컴 로컬(`~/.claude/...`) — 다른 컴 Claude는 이 세션 기억 없음. 대신 `.claude/skills/gaia-ai-lab/`(repo에 있음)로 워크플로 이어받음. 이 파일 + DECISIONS.md 읽으면 됨.
- 푸시는 쓰기권한 있는 계정에서 (이 세션 자격증명은 권한 없어 403).
