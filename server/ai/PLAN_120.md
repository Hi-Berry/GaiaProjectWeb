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
