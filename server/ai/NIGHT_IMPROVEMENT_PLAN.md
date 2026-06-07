# 야간 봇 강화 backlog (승자 180+ 목표)

사용자 지정 5대 고급 VP 엔진. 조사 결과(파일:라인) + 우선순위. 각 변경은 튜닝 비실행 중에만, 셀프플레이 8~10게임으로 검증(노이즈 완화), 개선/이론적 타당 시에만 commit.

## 교차 핵심: MCTS 후보 starvation
- `mcts.ts` simulate() 롤아웃이 `candidates.slice(0, TOP_N=8)`만 평가 (mcts.ts:~198-209).
- 루트는 expand()가 전 후보를 랜덤 확장하므로 한 번씩은 평가되나, 시간(250~400ms) 제약상 고급 액션은 방문수가 적고 롤아웃이 앞 8개로 편향.
- getCandidateMoves 순서(bot.ts:756~901): 연방→빌드→업글→특수→파워→우주선entry→우주선action→인공물→가이아포머→보너스→연구→패스.
- 개선: 우주선/인공물/고급기술 후보를 빌드/업글보다 앞으로 끌어올려 탐색 보장 (저위험 재배치). TOP_N을 10~12로 소폭 상향도 고려.

## 1. 우주선 액션 (findSpaceshipActions/Entry, bot.ts:2949~3127)
- Eclipse 6C 소행성광산(action3) 450점, Rebellion(380), TF-Mars(380). 잘 점수화돼 있으나 후보순서로 starve.
- 평가함수에 우주선 액션 미래가치 없음 → evaluator.ts ~550에 entered ship 중 미사용 action 잔여분 보너스(+) 추가.
- 개선 1.1 후보 재배치 / 1.2 evaluator ship future-value.

## 2. 우주선 연방 (federationPlanner.getRewardScore:123-160)
- **명백 버그: 모든 ship-fed-*가 300점 고정(line 128).** 차등화 필요:
  - ship-fed-tech 350(고급타일 잠재 大), ship-fed-12vp 280, ship-fed-3tf-mine 250, ship-fed-7vp3p2t 220, ship-fed-4vp1q2o 210, ship-fed-4vp4k 200, ship-fed-8vp8c 160, ship-fed-mine-free 90.
- 가장 우선 구현(고립 함수, 저위험).

## 3. 고급 기술타일 (bot.ts:726-733 생성, evaluator.ts:540-588 평가, gate gameState.ts:~4576)
- 전제 green fed + 트랙 L4 → 늦게 충족돼 0개로 끝남. (연방 초록토큰 타이밍은 이미 L3+로 앞당김 — 커밋 85ee917.)
- evaluator advTechScore 상한 600(line ~582) → 800~1000으로 상향(다연방형 타일 가치 반영).
- 커버 타일 선택이 "첫 미커버"라 고가치 타일 덮을 수 있음(gameState.ts:~698) → 최저가치 타일 커버로 개선(중위험).

## 4. 라운드 점수 타일 (bot.ts calculateRoundScoringBonus:3405-3419, evaluator.ts:440-466)
- 미래 라운드 보너스 1x로 약함 → 2x.
- evaluator roundBonus 1.1x → 1.5x.
- 마지막 라운드(roundsLeft==1) 해당 미션 보너스 1.5x(마지막 기회).

## 5. 인공물 (findTwilightArtifactActions bot.ts:3258-3290, 점수 3214-3255)
- totalPower>=6 게이트 → art-income-2p3(360점) 늦게 획득. 5파워 경로(소득형 제외) 허용 고려.
- 단일 후보 반환 → 상위 2~3개 반환(중위험).
- 소득형 인공물(art-income-2p3, art-income-1k1o) 미래가치 evaluator 미반영 → 추가(저위험, +5~10VP 추정).

## 구현 순서(보수적)
1. (즉시·저위험·버그) ship-fed 보상 차등화 [#2]
2. (저위험) 후보 재배치 + TOP_N 소폭 상향 [교차]
3. (저위험·가산) 소득형 인공물 미래가치 evaluator [#5]
4. (저위험) 라운드점수 미래/마지막라운드 가중 [#4]
5. (저위험) 고급타일 상한 600→1000 + 우주선 액션 future-value [#1,#3]
6. (중위험) 커버타일 선택 개선, 인공물 top-3 [#3,#5]

각 단계: 서버 재시작 → 셀프플레이 8~10게임(400ms) → avgWinner/해당지표 개선 확인 → commit, 아니면 revert.
주의: 자가대국 평균은 노이즈 큼(±5). 명백 버그/이론적 타당 변경 우선. 튜닝(가중치)은 별도 자기보정 트랙으로 병행.
