# AI 튜닝 초안 (150 VP 목표)

Evaluator 가중치와 MCTS를 조정해 봇 평균 VP를 올리기 위한 실행 순서와 추천 레버 정리.

---

## 0. 튜닝이 실제로 “강해지는” 구조인가?

**결론: 네. 설계상 Evaluator 가중치 개선 → MCTS가 더 좋은 수를 선택 → 자기대국 승자 VP 상승으로 이어집니다.** 다만 몇 가지 병목과 한계가 있어서 “눈에 보이는” 개선이 느리거나 한계에 부딪힐 수 있습니다.

### 인과 관계 (왜 강해지는가)

1. **튜닝 대상**: `tuneAi.ts`는 **Evaluator 가중치만** 바꿉니다. 이 가중치는 다음 곳에서 쓰입니다.
   - **MCTS 트리**: 깊이 제한에 걸린 리프 노드 → `Evaluator.evaluateState()` 점수로 backprop.
   - **롤아웃**: 매 스텝마다 후보 수를 1수 앞까지 시뮬레이션한 뒤 `Evaluator.evaluateState()`로 점수 매겨 best/2nd 선택 → 롤아웃 끝 상태도 Evaluator 점수로 backprop.
   - **수 선택**: 루트에서 `bestChild` = (누적 score / visits)가 가장 큰 액션을 선택.

2. **최적화 목표**: 자기대국 N판의 **평균 승자 VP**를 높이는 가중치를 찾습니다.  
   → “고득점 게임으로 이끄는 상태”를 Evaluator가 더 높게 점수 매기면 → 롤아웃이 그런 수를 더 선택 → backprop 점수가 올라감 → MCTS가 그 수를 실제로 둠 → **실제 대국 승자 VP가 올라감.**

3. **정리**:  
   - **같은 후보 풀·같은 MCTS 시간** 안에서는, 가중치가 “승자 VP와 상관 높은 상태”를 잘 반영할수록 봇이 강해지는 구조가 맞습니다.

### 한계·병목 (왜 개선이 안 보일 수 있는가)

| 원인 | 설명 |
|------|------|
| **후보 생성** | `getCandidateMoves`에 좋은 수가 아예 없으면, Evaluator를 아무리 잘 맞춰도 그 수를 두지 못함. 후보 풀 품질이 상한선을 정함. |
| **롤아웃 품질** | 5스텝, 1-ply, TOP_N=6. 가중치가 좋아도 롤아웃이 짧거나 후보 슬라이스가 좁으면 노이즈가 커서 MCTS 신호가 약해짐. |
| **평가 노이즈** | 후보당 5판처럼 적으면 “진짜 기대 VP 차이”를 구분하기 어려워, 운으로 올라간 best에 갇히거나 개선이 통계적으로 안 보일 수 있음. → `TUNE_UPDATE_EVERY=10` 이상 권장. |
| **지역 최적해** | mutation만 쓰면 넓은 가중치 공간 탐색이 제한적. reshuffle로 best 보정은 하되, 필요하면 sigma 키우기·그리드 서치 병행. |

**요약**: “실제로 강해지는 구조”는 맞고, 튜닝은 그 구조 위에서 작동합니다. 다만 **후보 생성·롤아웃·평가 게임 수**가 병목이면 개선 폭이 제한되거나 느리게 보일 수 있으니, 위 항목을 순서대로 점검하는 것이 좋습니다.

---

## 1. 실행 전제

- **서버가 켜져 있어야 함.**  
  터미널 1: `npm run dev`  
  튜닝/자기대국은 터미널 2에서 실행.

- (선택) 프로덕션에서 원격 튜닝 시 `AI_TUNING_TOKEN` 설정 후 요청에 `token` 포함.

---

## 2. 단계별 실행 순서 (초안)

| 순서 | 작업 | 명령 | 목적 |
|------|------|------|------|
| 1 | 자기대국 N판 돌려서 현재 수준 확인 | `SELF_PLAY_GAMES=30 npm run self-play` | 평균 VP·우승자 VP 확인, `data/selfplay-results.json` 생성 |
| 2 | 그리드 서치 (프리셋 여러 개 비교) | `npm run tune-ai:grid` | 연방/연구5/건물 등 프리셋 중 평균 우승자 VP 가장 높은 걸 `server/ai/aiWeights.json`에 저장 |
| 3 | 뮤테이션 튜닝 (같은 엔진, 무작위 변형) | `TUNE_GAMES=200 TUNE_GPC=15 npm run tune-ai` | 그리드에서 고른 베이스 주변을 미세 조정해 추가 상승 |
| 4 | 다시 자기대국으로 검증 | `SELF_PLAY_GAMES=50 npm run self-play` | 튜닝 후 평균 VP·우승자 VP 재측정 |

그리드 서치에서 후보당 게임 수를 늘리려면:

- `TUNE_GRID_GAMES=20 npm run tune-ai:grid`

---

## 3. 환경 변수 요약

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `SELF_PLAY_PORT` | 5000 | 서버 포트 |
| `SELF_PLAY_GAMES` | 10 | 자기대국 판 수 |
| `SELF_PLAY_OUTPUT` | `data/selfplay-results.json` | 자기대국 결과 JSON 경로 |
| `TUNE_GRID_GAMES` | 10 | 그리드 서치 시 후보(프리셋)당 게임 수 |
| `TUNE_GRID_MCTS_MS` | 2000 | 그리드 서치 중 MCTS 생각 시간(ms) |
| `TUNE_GAMES` | 1000 | tune-ai 총 게임 수 |
| `TUNE_GPC` | 20 | tune-ai 후보당 게임 수 |
| `TUNE_MCTS_MS` | 1000 | tune-ai 중 MCTS 시간(ms) |
| `AI_WEIGHTS_OUTPUT` | `server/ai/aiWeights.json` | 저장할 가중치 파일 경로 |
| `AI_WEIGHTS_PATH` | `server/ai/aiWeights.json` | 서버가 부팅 시 로드할 가중치 경로 |

---

## 4. 150점에 영향 큰 Evaluator 레버 (우선 조정 권장)

- **vpWeightLate**  
  후반 VP 1점당 평가 가치. 150점대를 노리면 **22 → 24~28** 정도로 올려보기.

- **federationValueEach**  
  연방 1개당 가치. 연방을 더 우선시키려면 **120 → 130~150**.

- **researchLevel5Bonus**  
  연구 5단 도달 보너스. 5단을 적극 노리게 하려면 **200 → 240~300**.

- **structureAcademy / structurePlanetaryInstitute**  
  학원·의회 가치. 고티어 건물을 더 선호시키려면 **140/120 → 150~170**.

- **structureRemainingRoundsFactor**  
  남은 라운드가 많을수록 건물 가치 배수. 확장·엔진 빌딩을 더 유도하려면 **1.0 → 1.1~1.2**.

- **researchEconomy / researchScience**  
  경제·과학 트랙 가치. 수입·지식 효율을 더 중요하게 보려면 소폭 상향.

프리셋 추가/수정은 `server/ai/tuneAiGridSearch.ts`의 `GRID_PRESETS` 배열을 편집하면 됨.

---

## 5. 참고

- 상세 구조·MCTS·롤아웃 개선: `STRENGTHENING_BOTS.md`
- 뮤테이션 튜닝: `server/ai/tuneAi.ts`
- Evaluator 기본값·타입: `server/ai/evaluator.ts` (`DEFAULT_EVALUATOR_WEIGHTS`, `EvaluatorWeights`)
