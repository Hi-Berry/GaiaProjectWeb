# AI 봇 강화 — 세션 핸드오프 (다른 머신/세션 이어받기용)

브랜치: `ai-bot-reliability-and-measurement`
목표: AI 봇 점수 강화. 사람 강자 ~209~273점 vs 봇 ~46~86점. 큰 격차.

## 측정 방법 (head2head A/B)
```
# challenger.flags.json 에 테스트할 플래그를 켠다 (예: { "myFlag": true })
$env:H2H_GAMES="60"; $env:H2H_MCTS_MS="400"; $env:AI_CHALLENGER_WEIGHTS="server/ai/aiWeights.json"
npx tsx server/ai/headToHead.ts > data/h2h-myflag.log 2>&1
# 결과: data/h2h-report.json (verdict) + 로그 꼬리(승률/VP마진/p값)
```
- 같은 테이블에서 챔피언(기본) vs 챌린저(플래그 켠 좌석) 좌석 분할, 6패턴 로테이션.
- 좌석별 플래그: `server/ai/variant.ts`의 `getPlayerFlag(playerId, key, fallback)` — `challenger.flags.json`을 읽음.
- **중요 한계: self-play는 봇끼리라 전략적 이득을 끝까지 검증 못 함 → "do-no-harm 게이트"로만 사용.** 진짜 검증은 사용자가 1:3으로 직접 플레이(사용자 270~300점).
- 테스트 끝나면 `challenger.flags.json` 을 `{}` 로 리셋할 것.

## 채택된 개선 (모두 기본 ON, 플래그로 끌 수 있음)
1. **clusterFedBonus** (`evaluator.ts`) — 위성 없이 연방 가능한 '밀집 건물 클러스터' 근접도 보상. 가까운 집 티어업(광산1→교역소/연구소2→의회/아카데미3)으로 7파워를 채우게 유도. **head2head 69% 승률, +5.38VP, p=0.02 — 이번 노력 첫 유의 개선.** `bestUnfederatedClusterPower` 헬퍼.
2. **fedSatEscalate** (`federationPlanner.ts`) — 위성 비용 급증 페널티 `sats*base + max(0,sats-2)*35`. 봇이 위성 ~10개로 파워 태우고 터지는 것 방지. do-no-harm.
3. **advTileReadyBonus** (`evaluator.ts`) — 고급 기술타일 준비 상태(초록연방 보유+트랙 L4 근접) 보상. do-no-harm +1.84.
4. **faction byFaction 프로파일** + **federation-forming eval** (이전 세션, 상시).

## 미채택 (head2head 음수/노이즈)
- buildOrderPlanner(연방 개수 강제, -3.55) / useGoalPlanner(번들, -1.52, 연방페이스 중복) / 가치망(노이즈, 사람 학습데이터 부족) / posAwarePlacement(유의 악화).
- 교훈: 연방 **개수**≠**질**. 밀집 클러스터(질)는 self-play로도 잡혔지만, 개수 강제는 해로움.

## 사람 빌드오더 분석 (완결 6게임, actionJournal=사람만 기록)
게임당 평균 R1~3 메인액션:
| R | 사람이 하는 것 |
|---|---|
| R1 | Tech 2.5 · **Ship 2.3** · TS 2.0 · Mine 1.7 · Research 1.2 · Lab 1.0 |
| R2 | **Mine 4.2** · FED 1.3 · Ship 1.2 |
| R3 | Mine 1.8 · FED 1.3 · Tech 1.3 |
→ 사람: **R1=우주선+업그레이드+기술타일, R2=광산 폭발+연방**. 우주선을 R1에 적극 진입(2번째로 흔한 R1 액션).

## 점수 내역 격차 (scoreBreakdown, 사람 209~233 vs 봇 46~75)
| 카테고리 | 사람 | 봇 |
|---|---|---|
| 기술타일 | 33~34 | **0** (고급타일 못 먹음) |
| 우주선 | 17~24 | **0** (VP 액션 안 씀) |
| 최종미션 | 27~33 | 6 |
| 라운드미션 | 39~49 | 12~20 |
| 연구 | 32~44 | 20~24 (편식) |

## 다음 표적 (우선순위)
1. **우주선 초반 진입/VP 액션** (봇 0점, 사람 R1 최우선). 봇은 입장이 VP -5라 근시안 회피. → 입장/탑승 가치를 평가에 반영(다단계 투자). `useGoalPlanner`의 우주선액션 보상(×35)만 분리 테스트 권장.
2. **연구 분산** — 봇 1~2트랙 몰빵, 사람 4~5트랙 L4+. `researchLevel5Bonus=350`이 깊이만 과보상. (단, 튜닝은 과거 null 많음 — clusterFedBonus처럼 '상태 보상'으로 접근)
3. **고급타일** — advTileReadyBonus로 일부. 트랙 L4 도달이 관건.

## 데이터
- 사람 게임 로그: `data/human-games/*.json` (R6 완결만 분석용). `scoreBreakdown` 포함(2026-06-12 이후 게임).
- Supabase에서 받기: `SUPABASE_SERVICE_ROLE_KEY=... node scripts/fetchSupabaseGames.mjs` (URL은 스크립트 기본값, 키는 Render env `SUPABASE_SERVICE_ROLE_KEY`).
- 분석 스크립트: `scripts/compareHumanVsBot.mjs`, `scripts/botByFaction.mjs`.

## 핵심 코드 위치
- 평가함수: `server/ai/evaluator.ts` (clusterFedBonus, advTileReadyBonus, useGoalPlanner 등 federation 블록 ~520~800).
- 연방 플래너: `server/ai/federationPlanner.ts` (fedSatEscalate).
- 봇 후보 생성: `server/ai/bot.ts` (우주선 액션 `findSpaceshipActions` ~120, 고급타일 후보 ~756, 연방 ~786).
- 플래그: `server/ai/variant.ts`.
