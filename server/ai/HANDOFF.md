# 봇 강화 작업 핸드오프 (다른 컴퓨터에서 이어가기)

브랜치: `ai-bot-reliability-and-measurement`. 목표: 봇을 강하게(A안=다턴 시퀀싱 공략), 모든 변경은 head2head(p값)로 검증해 **개선 시에만 채택**.

## 가장 중요한 인사이트 (지금까지)
- 강한 사람 게임 1판 확보: **Space Giants 273점** vs 봇 56/52/46 (data/human-games/2026-06-08_dn8vkjxf.json). 분석: `server/ai/HUMAN_273_BUILDORDER.md`.
- **iter1 `useGoalPlanner`(평가 바이어스)는 head2head에서 더 약함**(33.3%승, VP−4.3, p=0.046) → 기각.
  → 재확인: 봇 약점은 **가치 평가가 아니라 다턴 실행/시퀀싱**. 평가에 손대면 오히려 악화.
  → 다음 레버는 **탐색(롤아웃)** 또는 사람데이터 스크립팅/RL.

## 현재 코드 상태 (모든 실험은 플래그 게이팅 → 프로덕션/champion 동작 불변)
- `evaluator.ts`: `useGoalPlanner` 블록 — **기각됨**(flag off라 inert). 기록용으로 남김. 정리해도 무방.
- `mcts.ts`: `deepRollout` 블록 — **검증 미완**. 롤아웃이 메인액션 1회 후 중단하던 근시안을 교정해
  남은 자원으로 다턴 연쇄(MAIN_ACTION_CAP=5)를 시뮬. 수입/상대턴은 미반영(휴리스틱).
- `server/ai/challenger.flags.json` = `{"deepRollout": true}` (다음에 마저 돌릴 실험 설정).

## 이어서 할 일 (우선순위)
### 1) iter2 deepRollout 검증 마무리 (직전에 3/36에서 중단됨)
```bash
git pull
printf '{ "deepRollout": true }\n' > server/ai/challenger.flags.json
H2H_GAMES=60 H2H_MCTS_MS=400 AI_CHALLENGER_WEIGHTS=server/ai/aiWeights.json npx tsx server/ai/headToHead.ts
# 결과: data/h2h-report.json + 콘솔. verdict 확인.
```
- ✅ 유의 개선이면 → `mcts.ts`의 MAIN_ACTION_CAP(3/5/7) 튜닝 재검증 → deepRollout을 기본값(플래그 제거 or 기본 true)으로 승격 + 커밋.
- ➖/❌ null·악화면 → 아래 iter3 후보로.

### 2) iter3 후보 (각각 플래그 게이팅 → head2head)
- `deepRollout` + **수입 근사**: 가상 다턴 사이에 구조물 기반 자원 대략 지급(우주선 액션은 다음 라운드 수입으로 쓰는 패턴을 잡으려면 필요). 단 수입 근사가 부정확하면 오히려 왜곡 — 주의.
- **2-ply 셋업 룩어헤드**: simulate의 후보 점수화 시, 셋업류(우주선진입/가이아포머/L4도달) 액션은 "그 후 최선 후속수"까지 1수 더 보고 점수. (롤아웃 전면개조보다 안전)
- **종반(R6) 최적화**: 잔여자원→VP 환산, 인공물 종반 환산, 부스터 매칭. 273게임은 R6에 인공물(Science×3·Tracks×3=30VP)+패스보너스로 폭발.
- 강한 사람 게임 **종족별로 더 수집**(현재 1판) → 종족별 빌드오더 근거 보강.
- (헤비) value-net을 **약한 self-play가 아니라 강한 데이터**로 학습 / AlphaZero식 정책+가치 동시학습.

## 측정 방법 (반드시 이걸로)
- `headToHead.ts`: champion(aiWeights.json) vs challenger(challenger.flags.json 플래그). **가중치는 AI_CHALLENGER_WEIGHTS=server/ai/aiWeights.json로 고정**해 플래그 효과만 격리.
- 60판 이상 권장, verdict가 ✅(유의)일 때만 채택. A/A(플래그 동일)로 노이즈 기준선 점검 가능.
- self-play 평균 VP는 노이즈 ±5라 단독 판단 금지(과거 야간작업의 함정).

## 이미 커밋된 버그수정 (394280c)
ship-fed-7vp3p2t→그릇3 토큰2(+7VP), 미탑승 우주선타일 선택 거부+에러토스트, 미니리서치 우측잘림(gutter 14), 사이드바 인라인 로그 복원. (서버 재시작 시 적용)

## 진행 로그
`server/ai/STRENGTH_FINDINGS.md` 하단 "야간 강화 시도 로그" 참고. iter 결과를 계속 여기에 누적.
