# 가치망 배선 (Phase 2 기반) — 2개 시스템, 절대 섞지 말 것

2026-07-07 밤 사고: `trainHumanValueNet.ts`가 33피처 ValueNet을 `humanValueNet.json`(22피처 consumer)에 써서
computeHumanValueVP가 쓰레기 predVP 반환 → humanValueBlendK 켠 봇 즉시패스(VP −61). 배선 오배선이 원인.

## 시스템 ① — 인라인 22피처 선형 (레거시 핸드피처)
- **피처**: `evaluator.ts computeHumanValueVP()` 안에 하드코딩된 22개 (round, 건물수, 연구레벨, 클러스터, gaiaformer 등). features.ts와 **다름**.
- **모델 파일**: `server/ai/humanValueNet.json` = `{weights: number[22]}` (선형 릿지).
- **consumer**: `humanValueBlendK` 플래그 (기본 0=OFF). `score += K × computeHumanValueVP`.
- **학습기**: `scripts/valueProbe.mjs` (이것만 humanValueNet.json에 써야 함).
- 상태: 39게임 학습, 블렌드 중립(value-net-blend-neutral). Phase 2에서 **안 씀**(레거시).

## 시스템 ② — features.ts 33피처 MLP  ★Phase 2 레버
- **피처**: `server/ai/features.ts` `extractFeatures()` = **FEATURE_DIM(33)**, 상대-상대적 지표(scoreVsMaxOpp 등) 포함.
- **모델 파일**: `server/ai/valueNet.json` = 2-은닉층 MLP(`ValueNet` 클래스, dim33·H1=1056·W1/b1/W2/b2/W3/b3).
- **consumer**:
  - `useValueNet`(OFF): 휴리스틱 **대체** → `net.predict(extractFeatures)`를 리프값으로.
  - `valueNetBlend`(OFF) + `valueNetBlendW`(0~1, 기본0.5): VP항을 `(1-w)*현재점수 + w*예측`으로 **convex 블렌드** ← 사용자의 "0.9휴+0.1망" 직관은 이걸 작은 w로.
  - `VALUE_NET_OUT` env로 파일 경로 override 가능(A/B용).
- **학습기**:
  - `server/ai/trainValueNet.ts` → valueNet.json (self-play 데이터 `data/valuenet-data.jsonl`).
  - `scripts/trainHumanValueNet.ts` → **valueNet.json**(2026-07-08 OUT 기본값 수정, 과거엔 humanValueNet.json이라 ① 오염) (사람 데이터 `data/human-features.jsonl`, reconstructHumanFeatures.ts 산출).

## Phase 2 규칙
- **가치함수 재학습은 시스템 ②(valueNet.json)만.** ①(humanValueNet.json)은 건드리지 말 것.
- 학습 후 `valueNetBlend`+작은 `valueNetBlendW`(0.1~0.2)로 head2head do-no-harm 확인 → 나아지면 w 상향/useValueNet 검토.
- 자가대국 루프: MCTS 자가대국 → (extractFeatures, 최종VP) → data/valuenet-data.jsonl → trainValueNet → 반복. 매 iteration head2head 게이팅.
- 검증: 학습 후 게임단위 val split, 상대-상대적 피처 gradient 부호가 도메인상 맞는지 probe.
