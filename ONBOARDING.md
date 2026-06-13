# Gaia 봇 강화 — 인계/재개 가이드

목표: AI 봇을 **사람과 붙을 만큼**(강한 사람 ~223점) 강하게. 검증은 사용자 1:3 실전(사용자 270-300점).

## 결론 한 줄
손튜닝/연산/search로는 천장(봇 ~60% 엔진) 못 깸이 **실험으로 증명됨**. 사람대등 유일 경로 = **학습된 eval**, 단 **사람 데이터 ~10배**(현 435샘플→~5000, 강한게임 ~50-100판) 필요. 데이터가 게이트.

## 천장 증거 (모두 재탐색 금지 — null 확인됨)
1. eval 보너스 튜닝 = A/A 포화. 8+ 플래그(expandDrive/shipEngine/fedPace/fedMinTrim/useGoalPlanner 등) null.
2. 연산 스케일 = mctsTimeMul=4 음성(greedy라 스케일 안 됨).
3. 학습 가치망(섞은 데이터) = 엔진 gradient +0.0(현재 score만 읽음, score 마스킹해도 평탄). 데이터 기아.
4. income 롤아웃(벽돌1, rolloutIncome.ts) = head2head null(54.5%).
5. 상대-인지 search(벽돌2, oppRollout) = 500ms·1500ms 양쪽 null/중립. 연산 스케일 안 됨.
→ **eval이 절대 천장**: search가 깊어도 끝 상태를 같은 saturated eval로 평가하니 루트선택 개선 안 됨.

## ★ 전진 경로 검증됨 (긍정)
- **HUMAN_ONLY 학습**(순수 사람 435샘플) → 비평탄 gradient: **techTiles 2.7→8.5 = +22.5 VP**, fed +2.5, struct +1.0.
  (섞은 데이터는 평탄했음 → 사람데이터가 "엔진↑→VP↑"를 실제 인코딩. 손튜닝 eval이 못 잡은 것.)
- 현재 435샘플은 과적합(gaiaPlanets -10.9 등 노이즈)이라 직접 eval로 못 씀. **데이터 늘면 작동.**

## 데이터 충분(≥~50 강한게임) 시 재개 절차
1. `VALUE_NET_DATA=data/valuenet-data.jsonl VN_HUMAN_ONLY=1 npx tsx server/ai/trainValueNet.ts` (또는 HUMAN_WEIGHT 큰 값으로 섞기). **leave-one-game-out 검증 권장**(scripts/trainMasked.ts가 누출방지 split 예시).
2. `node scripts/probeValueNet.mjs <net>` 로 엔진 gradient가 안정적 양성인지 확인(techTiles/fed/struct +, 노이즈 음성 사라졌는지).
3. 안정적이면 evaluator.ts에 **작은 블렌드 항**(handEval + α·netVP, α 작게)으로 추가, flag 게이트. **1-ply 봇이라 OOD 악용 위험 낮음**(value-net-as-deep-MCTS-leaf는 과거 실패, 1-ply 블렌드는 안전).
4. head2head **짧게(≤24판) do-no-harm** 검증 → 좋으면 채택. 그 후 oppRollout(search 인프라) 재가동: **좋은 eval + search = 강함**(지금은 eval이 천장이라 search 무효였음).

## 살아있는 채널 (데이터 무관, 즉시 적용)
사용자가 본 **구체적 오플레이** → 즉시 수정·채택. 이번 세션 이렇게 채택: navBeforeJump(QIC점프 전 nav), 고급타일 hang수정, R6-가이아포머 가드(최종라운드 성숙불가 낭비), 가이아포머-pass VP 버그. 전부 correctness(eval튜닝 아님)라 효과적.

## 방법론
- 모든 변경 head2head A/B do-no-harm 게이트. challenger.flags.json에 도전자 플래그, 테스트 후 `{}` 리셋.
- **head2head 인프라 주의**: 긴 run(40판+)서 워커 무응답/사망해 결과 미기록 반복. **짧게 쪼갤 것**. correctness 수정은 타입체크+논리로 채택, 휴리스틱만 짧은 head2head.
- 자가대국 SCORE는 zero-sum 포화 — 진짜 신호는 객관지표(연방수/구조물수)나 사용자 1:3 실전.

## 코드 자산 (flag OFF, 라이브 무해 — 재활용 대기)
- `server/ai/rolloutIncome.ts` (정확 income), `mcts.ts` simulateWithOpponents (oppRollout/rolloutFatScore/realRolloutIncome 플래그)
- `server/ai/trainValueNet.ts`, `scripts/trainMasked.ts`, `scripts/probeValueNet.mjs` (학습/프로브 harness)
- `server/ai/STRENGTH_FINDINGS.md` (전 실험 상세 로그)
- 메모리: `ai-greedy-ceiling.md`
