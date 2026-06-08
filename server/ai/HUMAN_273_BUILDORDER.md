# 강한 사람 게임 분석 — Space Giants 273점 (2026-06-08_dn8vkjxf)

봇이 못 깨는 "다턴 빌드오더"의 근거 데이터. 사람 273 vs 봇 56/52/46.
data/human-games/2026-06-08_dn8vkjxf.json, 분석기: scripts/analyzeHumanBuildOrder.mjs

## 최종 상태 (이게 목표 프로필)
- research: **terr4 navi4 arti4 gaia5 scie5** — 5개 트랙을 L4~5로 (봇은 보통 1개만 L5)
- techTiles: **11개** (고급 2: adv-act-1q-5c, adv-pass-2vp-asteroid + tech-big-4str, tech-imm-7vp 등)
- federations: **4개** (R1에 첫 연방!) — 봇은 1개
- booster: 매 라운드 교체(mine→2tokens→mine→ts→2tokens→mine)로 패스 VP 극대화

## 점수원 (봇이 0에 가까운 것들)
- 패스 보너스(구조물당 VP): mine/ts 부스터로 매 라운드 2~8VP
- **고급기술 패스 보너스: adv-pass-2vp-asteroid = R4 +12, R6 +14VP**
- **인공물(Twilight) VP 폭탄: R6에 Science×3=15, Tracks≥3×3=15, planet-types** → 종반 30~45VP
- Eclipse 6C 소행성광산 엔진(R2~R4 반복) → 확장 + 소행성수 누적
- 최종미션: asteroid_buildings 18 + satellites 18 = **36VP**

## 핵심 다턴 시퀀스 (봇 결여)
1. **우주선 조기 탑승**: R1에 rebellion+twilight, R2에 eclipse 모두 탑승. 탑승 −5VP를 감수 —
   2~3턴 뒤 (기술타일+소행성광산+인공물+우주선연방)으로 50VP+ 회수. **봇은 −5VP만 보고 안 탐.**
2. **Eclipse 6C→소행성광산 엔진 반복**: 싼 확장 + adv-pass-2vp-asteroid + fm_asteroid_buildings 트리플 시너지.
3. **연방 조기·다수(R1부터, 총 4)** → 초록토큰 → L5 연구 + 고급 기술타일 잠금해제.
4. **연구 다(多)트랙 심화(5트랙 L4~5)** → 지식수입(연구소+아카데미+science) 기반.
5. **고급 기술타일을 패스보너스(adv-pass-*)로** 매 라운드 누적 수확.
6. **부스터 사이클링**: 현재 구조물 분포에 맞춰 매 라운드 부스터 교체로 패스 VP 최대화.
7. **인공물 종반 환산**: twilight 조기 탑승→누적→R6에 Science/Tracks 인공물로 30~45VP 일괄.
8. **하나의 엔진이 여러 점수원 겸함**: 소행성광산 = 확장 + adv-pass + 최종미션. 위성 = 연방 + 최종미션.

## 봇과의 격차 = "시퀀스를 엮지 못함" (STRENGTH_FINDINGS와 일치)
봇은 각 요소(연방·연구·우주선)의 가치는 알지만, "지금 −5VP 내고 우주선 타기 → 다음 턴 소행성광산 →
adv-pass 타일 → 매 라운드 +12VP"의 **다턴 인과 사슬**을 보지 못함. MCTS 깊이8 + 근시안 롤아웃의 한계.

## 플래너 설계 방향 (다음 단계)
MCTS 위에 **목표(goal) 매크로 레이어**:
- 종족별 시드 목표 시퀀스(예 Space Giants: "R1 PI+ship진입 → R2 eclipse엔진 → R2-3 연방2개 →
  R3-4 트랙2개 L4→adv-pass타일 → 매라운드 부스터매칭 → R5-6 인공물환산").
- 목표는 후보 생성/평가에 **보너스 바이어스**로 주입(강제 아님): 현재 목표를 달성하는 후보 점수↑.
- 우주선 진입의 −VP를 "예약된 미래가치"로 상쇄(이미 시도했으나 과탑승 → 목표기반이면 1척만 정조준).
- head2head로 검증하며 종족별 시퀀스 튜닝.
