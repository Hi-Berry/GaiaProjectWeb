# 봇 코드 지도 (server/ai/) + 로그 포맷

기억에 의존하지 말고 매번 grep으로 현재 위치 확인 (라인번호는 변함). 아래는 "어디를 봐야 하나"의 길잡이.

## 의사결정 흐름

- **`bot.ts` `getCandidateMoves(game, playerId)`** — 한 턴의 후보 액션 목록 생성. **MCTS와 getNextMove 둘 다 이걸 씀.** 여기서 후보를 빼면 봇은 그 액션을 못 함.
  - 펜딩 상태(고급타일 커버/트랙전진, 기술타일 선택, 우주선기술 광산, pendingTerraformSteps) → 일찍 return (강제 처리).
  - 연방 후보(FederationPlanner) → 빌드(findBuildActions) → 파워액션(findPowerActions) → 우주선 입장(findSpaceshipEntryActions)/액션(findSpaceshipActions) → 인공물 → 가이아포머 → 자원변환 → **연구(knowledge≥4면 advance_research)** → 패스(knowledge≥4면 패스 억제).
  - **사거리 부스터 활성 시 후보를 사거리 사용 액션만으로 필터**(dedup 직전). 부스터 켜고 엉뚱한 짓 방지.
- **`bot.ts` `getNextMove(...)`** — 후보 1개면 그대로, 여러 개면 `MCTS.search`. `isSimulate`면 가중랜덤(롤아웃 다양성).
- **`mcts.ts`** — MCTS 탐색. **사용자 본인 수정 영역 — 함부로 커밋하지 말 것**(요청 시에만). 읽어서 진단은 OK.

## 평가/점수

- **`evaluator.ts`** — 포지션 평가 가중치(`aiWeights.json`의 `global` + `byFaction` 적용). `byFaction[player.faction]` 패치를 global에 덮어씀(종족별 가중치, line ~313 부근).
- **`aiWeights.json`** = `{ global, byFaction }`. byFaction은 현재 11종족, 대부분 "연구 트랙 우선순위"만 얕게. 7종족(hadsch_hallas/taklons/bescods/firaks/moweyip/tinkeroids/darkanians) 미커버.
- **`tuneAi.ts` / `tuneAiAuto.ts`** — 종족별 가중치 튜닝 스크립트.

## 행동별 점수 위치 (bot.ts)

- 빌드(광산): `findBuildActions`, 펜딩스텝: `findBuildActionsWithPendingSteps`.
- 파워액션: `findPowerActions` (gain-2-ore/7-credits/2-knowledge/1·2삽 등). 스텝 액션이 빌드와 콤보로 묶여 점수↑라 자원액션보다 자주 선택됨.
- 우주선 입장/액션: `findSpaceshipEntryActions` / `findSpaceshipActions`. 입장 점수는 낮게(과탑승 방지) 튜닝돼 있음.
- 연방: `federationPlanner.ts` `getFederationActions` (위성 페널티·보상 점수), bot.ts에서 후보로 push. 업그레이드로 연방 닫기 보상: `getBestFederationSpentTokensAfterUpgrade`.
- 사거리 부스터 유용성 가드: `rangeBoosterUnlocksTarget`.

## 서버 규칙(gameState.ts) — 봇이 우회하는 것 주의

- 봇은 `BotLogic.performAction` → `execute*` 함수 직접 호출(소켓 핸들러 우회). 소켓에만 있는 가드(`hasActiveRangeBonus` 차단 등)는 봇에 안 먹으니 **후보 단계에서 막아야** 함.
- 연방 파워값: 광산1 / 교역소·연구소2 / 의회·아카데미3(베스코즈·이비츠 또는 big타일이면 4). 7 이상이면 연방.
- 무료 광산 플래그: `nextMineFreeFromShipTech`(우주선 기술 2TF+광산), `spaceshipFed3TfMineFree`(우주선 연방 3TF). 팅커로이드 +3TF는 스텝만 무료, 광산 1O2C 청구(정상).
- L4→L5 연구는 **초록 연방 토큰** 필요. 초록 연방 없으면 L4 트랙은 연구 불가 → 지식 묶일 수 있음.

## 로그 포맷 (분석용)

- 라이브 `game.gameLog`: 2000개 캡(과거 100이라 shift로 길이기반 reset이 깨지던 버그 있었음 → gameLogSeq 도입). 엔트리: `{timestamp, playerId, playerName, action, details?, tileId?, subLogs?, snap?, base?, round?}`.
  - `snap`/`base` = 그 로그 시점 행위자 점수/자원(클릭 시 변동량 표시용). `round` = 발생 라운드.
- **전체 로그 `fullGameLog`**(humanGameLogger): 캡 없이 누적, 게임 종료 시 `data/human-games/`에 저장. **분석은 이걸 쓴다.**
- 연방 로그 디테일: `"Formed federation (N 위성, P power)"` 또는 `"... reward: ..."`.
- 종족 id 목록은 `shared/gameConfig.ts` FACTIONS. 봇 playerId는 `bot-` 접두.
