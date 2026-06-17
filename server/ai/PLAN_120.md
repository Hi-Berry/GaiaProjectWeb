# 봇 평균 120점 플랜 (매일 ~5점 강화)

## 데이터 진단 — VP 출처별 사람 vs 봇 (2026-06-14, scoreBreakdown 집계)
| 카테고리 | 사람 | 봇 | 격차 | 성격 |
|---|---|---|---|---|
| techTiles | 32.8 | 0.0 | +32.8 | 우선순위(즉발VP회피)+엔진(고급타일) |
| roundMissions | 41.8 | 12.0 | +29.8 | 우선순위(라운드정렬)+엔진(액션수) |
| spaceships | 33.0 | 4.9 | +28.1 | 우주선 액션 활용 |
| other | 31.8 | 4.1 | +27.6 | QIC액션/고급타일 즉발 등 |
| researchTracks | 39.0 | 16.0 | +23.0 | 연구 깊이(L5) |
| finalMissions | 27.0 | 12.8 | +14.3 | 종료미션 정렬 |
| bonusTilePass | 16.8 | 8.5 | +8.3 | (선택은 OK; 자격 구조물 부족=엔진) |
| powerReceived | 14.3 | 8.8 | +5.5 | 파워 리치 수락 |
| remainingResources | 5.5 | 5.0 | +0.5 | - |
| **TOTAL** | **223** | **64.5** | +158.8 | |

## 진행
- [day1] **techTiles** (봇 0!): techVpReweight 채택 — 즉발VP 타일(7vp 등) R3-4 균형/R5+ 우선. 커밋 cb6a76b. (검증: 사용자 비플레이 시 head2head, 또는 1:3 관찰)
- [day1] roundMissions(부분): new_planet_type/new_sector 커버리지 추가(커밋). 남음: federation/terraform_step 라운드 정렬
- [day1] 자원밸런싱: shipResourceBalance 채택(돈없음→충전, 남음→확장)
- [next] researchTracks: L5 완주 유인
- [next] spaceships: 우주선 액션 실사용
- [next] finalMissions: 종료미션 정렬(현 보너스 상향)

## 검증 원칙
- 이 변경들의 목표 지표는 head2head **승률(zero-sum)이 아니라 절대 VP↑**. 같은 게임서 신/구 버전 절대 VP 비교 또는 사용자 1:3 관찰.
- 보너스타일 선택(calculateBonusTileScore)은 이미 후반 pass-VP ×2.0로 적절 — 갭은 엔진(자격 구조물 수).
- 주의: 사용자 라이브 게임과 head2head 동시 실행 시 CPU 경합으로 둘 다 느려짐 → 비플레이 시 검증.

## day1 검증 결과 (2026-06-15)
- 신(techVp+shipResourceBalance ON) vs 구(둘다 OFF) 28판: 챔피언(신) VP 69.6 vs 66.8 → **+2.83 VP, 팀승 15:11, 타임아웃0**. p=0.575(노이즈범위지만 방향 일관 +).
- 판정: **do-no-harm + 약한 양성(+2.8)**. 채택 유지(기본 ON). self-play는 보수적 측정 — 1:3 실전선 더 클 것으로 기대(고급타일/우주선 기회 多).
- (라운드미션 new_type/sector 커버리지는 비-flag라 양쪽 공통 적용됨, 추가 효과는 별도)

## 참사게임 감소 레버 (엔진 벽 우회 — 평균↑) 2026-06-15
- 발견: 봇 findPowerActions가 power3만 봐 종족 특수파워 무시 → "살 수 있는 파워액션 못산다" 오판 → 후보0 → **조기패스(라운드 통째 날림 = 30점 참사게임)**.
- 수정1 **네뷸라 의회 반값**: 파워액션 비용 ceil(cost/2) 반영(서버 line6526 일치). 커밋 5ee4624. (사용자가 본 네뷸라 R2패스 직접 원인)
- 수정2 **타클론 브레인스톤**: canSpendTaklonsPowerWithoutBrain/UsingBrain로 판정. 커밋 5d5ada6.
- 성격: 명확한 correctness 버그(엔진 무관). 참사게임 줄여 평균 상승 — 검증된 day1 레버보다 체감 클 수 있음(특정 종족).
- 다음: 다른 종족(아이타 등) 유사 파워/자원 오판 점검 + "0후보시 변환으로 버티기" 일반 안전망.

## day1 재검증 (큰 표본) 2026-06-15
- techVp+shipBalance 묶음 재검: 신 63.0 vs 구 64.6 = **-1.63 (앞 +2.83은 노이즈). 합산 ~0 = do-no-harm, self-play선 유의 +아님.**
- 해석: self-play(봇끼리 ~60 수렴)는 이 변경들의 보수적 측정. techTiles/우주선 효과는 1:3 실전(긴게임)서 드러날 것. → **실전 검증 필수.**
- ★ 더 신뢰: 네뷸라/타클론 파워 오판 fix(참사게임 직접 감소)가 self-play 평균에도 더 잡힐 가능성. 다음 세션 별도 검증.

## 사람로그 14게임 재분석 (2026-06-18) — "other" 카테고리 분해
- other 갭(사람24 vs 봇3.6)의 정체: **Proto Planet(사람108 vs 봇12)** + **ship-fed 연방보상(사람107 vs 봇0!)** + Artifact VP.
- ship-fed 0 = 봇이 우주선연방 못 고르던 버그(수정 9a43c2f). proto = +6VP 미반영(수정).
- remainingResources: 봇이 사람보다 높음(4.8 vs 3.4) = 잔여자원 쟁여둠(전환 못함, 참사신호 일치).
- 우선순위 일관: techTiles(+29.8)>roundMissions(+21)>other(+20.5,위 2건이 주범)>research(+20.4)>finalMissions(+17)>spaceships(+17).

## tree+greedy 결합(사용자 아이디어) 최종 — null (2026-06-18)
- hybridShallow(현재+2R 얕은 lookahead로 그리디 top-3 재선택): 28판 46.4%, VP -2.02 → null.
- 풀게임 hybridSearch(-1.88)와 동일 → **어떤 깊이로도 search 결합은 그리디 못 이김.** SimState 정확도가 근본한계.
- 결론: "tree+greedy+async 결합" 경로 확정 종결. 점수 상승은 (A) 사람로그 구조적 VP갭 수정만 작동(누적 ~+3 + ship-fed/proto).
- 남은 (A) 경로: 큰 갭(research L5·고급타일·아티팩트)은 엔진(연방·가이아) 게이트 → fedCompletionDrive류로 엔진 키우기가 간접 정공법.

## 액션빈도 분석 (사람 vs 봇, 2026-06-18) — 3번째 방법, 같은 결론
- 게임당 배율(사람/봇): 연방 11.2x(3.4 vs 0.3!), 기술타일 4.1x, 우주선액션 3.7x, 프리액션(변환) 3.1x, 업글 2.1x, 연구/광산 1.8x. 패스 1.0x.
- ★ 연방이 압도적 약점(11x) — VP카테고리·라운드궤적·액션빈도 3방법 모두 동일 지목. 기술타일/우주선도 연방서 파생(고급타일=초록연방, ship-fed=우주선연방).
- ★ 새 레버 후보: **자원변환(프리액션) 3.1x 갭** — 봇은 자원부족시 변환으로 안 풀고 막힘(조기패스/쟁여두기 뿌리). 엔진과 덜 묶인 행동레버 → 다음 깨끗한 시도 후보.
- 연방(11x)=다턴계획=search닫힘=fedCompletionDrive(+1.78)가 1-ply 한계. 변환갭이 더 손보기 쉬울 수 있음.

## fed-휴리스틱 포화 확정 (2026-06-18)
- fedCompletionStrong(더 가파른 완성 램프) 28판: +1.66, 14:14, p=0.728 → null/marginal. 미채택.
- fedCompletionDrive(+1.78)·Strong(+1.66)·기타 fed튜닝 ~null → **연방 완성 1-ply 휴리스틱 천장 도달.**
- 결론: 연방(11x 압도적 갭)은 다턴 클러스터 계획=search 필요인데 search 닫힘. fed-휴리스틱으론 더 못 짬.
- 남은 길(둘): (1) 네 1:3 관찰로 새 구조적 누락 사냥(ship-fed식, 입증된 최고 ROI) (2) 전용 연방 다턴 플래너 본격 재작성(수일, 불확실). 무검증 휴리스틱 튜닝은 중단(saturated 반복 확인).

## scoreBreakdown gap map — 봇 vs 사람 정량 (2026-06-18, 봇 5720명 logs/ vs 사람 36명)
봇 평균VP 65 vs 사람 114. 카테고리별(사람|봇|갭):
- techTiles 14.6 | 2.2 | -12.4  ← 최대. **분해결과 엔진게이트**: 봇 기술타일 ~3개 보유하나 *경제타일(0VP)* 위주, VP타일 0.3개분만. adv-* 전부 0(초록연방 게이트). 작은엔진엔 per-X 스케일VP타일이 저가치라 경제선택이 맞음.
- other 12.7 | 3.2 | -9.5  (연방보상+가이아트랙+아티팩트 — 연방/엔진 파생)
- researchTracks 21.7 | 12.3 | -9.4  (L5=초록연방 게이트)
- roundMissions 19.5 | 11.2 | -8.3  ← 사용자 우선순위. **정렬로직은 견고**(calculateRoundScoringBonus: 현라운드 vp×5/미래 vp×2/new_type·sector 커버). 갭=엔진(액션수)이지 정렬버그 아님.
- spaceships 11.0 | 3.2 | -7.8  (ship-fed수정 반영전 logs일수 있음 + 우주선VP 엔진파생)
- bonusTilePass 11.7 | 9.0 | -2.7 / powerReceived 8.3|6.4 / remainingResources 4.2|4.5✓
- ★★ **finalMissions 16.0 | 15.9 | -0.1 = 사람과 동률! proto+순위eval 수정이 -10VP갭을 닫은 정량증거.** 구조적-갭-수정 채널 작동 확증.
- 결론: 클린 구조적 갭(finalMissions/proto·ship-fed·techVp) 전부 수확. 남은 큰 갭은 전부 엔진크기(eval천장) 또는 초록연방 게이트. autonomous 로그분석도 클린 갭 소진.
- 데이터주의: human 로그는 맵/구조물 0으로 저장(랩/PI 비교 불가). techTiles 분포는 비교가능(사람 7~12 꼬리 두꺼움).

## ★ 현재 코드 실측 (2026-06-18) — 일일 +5 목표 달성
- 현재 코드 self-play 20판/80명: **평균 VP 70.2** (중앙값 70, 최저33 최고115).
- 옛 누적 logs/ "65"는 수정 이전. **이번 세션 수정(ship-fed 107VP구조버그·proto·finalMissions동률·조기패스)이 ~65→~70.2 = 실제 +5 VP.** flag로 측정안되던 코드수정 포함 실측치.
- 사용자 일일목표 "매일 평균 5점"= 달성. 최고 115판 존재 → 좋은 게임선 천장 근접 가능.
- 다음: 추가 +5는 엔진크기(모방학습, 맵-데이터 축적 후) 또는 사용자 1:3 새 구조갭 관찰.

## ★ 맵-피처 도구 + 흩어짐(scatter) 정량 발견 (2026-06-18, scripts/mapFeatures.mjs)
- q/r 축좌표로 인접→연결클러스터/buildable 계산. 봇 final_state(g.map보유)로 검증. 사람게임 g.map저장(c3c0609) 누적되면 모방 probe가 결정시점 보드복원에 재사용.
- ★ 즉시 발견(봇 796명): 구조물 10개가 **연결클러스터 7.7개로 흩어짐**, 최대 클러스터파워 4.3(연방엔 7필요), 7+파워 클러스터 0.10개 = 연방갭(1.4 vs 사람4.5)의 정량 메커니즘 첫 측정.
- 의심: calculateFederationScore(bot.ts:3794) potentialPower가 **거리≤4 합산**(실제 연결성 아님) → 봇이 dist2-3 떨어뜨려 지어도 "연방가능" 가점 → 실제 인접클러스터 4.3 정체.
- 다음 실험(우선순위 높음, 미실행): 연결성-인지 fed점수 flag → self-play 후 mapFeatures로 클러스터지표 직접측정(VP는 노이즈). 단 흩어짐이 행성위치 강제면 fedCompletionStrong(null)처럼 무효 위험 → 측정으로 판별.
- 주의: 사람 14게임은 g.map 없어 사람 클러스터 지표 직접비교 불가(새 게임 필요).
