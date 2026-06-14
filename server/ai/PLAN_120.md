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
