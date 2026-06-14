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
