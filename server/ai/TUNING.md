# AI 튜닝 초안 (150 VP 목표)

Evaluator 가중치와 MCTS를 조정해 봇 평균 VP를 올리기 위한 실행 순서와 추천 레버 정리.

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
