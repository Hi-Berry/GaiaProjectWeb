---
name: gaia-ai-lab
description: Gaia Project AI 봇을 데이터 기반으로 점점 강하게 만드는 작업 루프. 사람/봇 게임 로그를 읽어 약점(약한 종족·낭비 액션·룰 위반)을 찾고, 가설을 플래그로 구현해 head2head로 검증한 뒤 채택/기각하고 그 결과를 DECISIONS.md에 누적한다. 트리거: "봇 강화", "종족 전략", "head2head", "로그 분석해서 봇 개선", "약한 종족".
---

Gaia Project 봇(`server/ai/`)을 **로그 분석 → 가설 → 구현(플래그) → head2head 검증 → 채택/기각 → 기록**의 반복 루프로 개선한다. 추측이 아니라 **데이터와 측정**으로만 발전한다.

## 제1원칙 (우선순위 순)

1. **측정 없이 채택 없음.** 전략/평가 가중치 변경은 반드시 `head2head`로 검증한다. 단순 룰/버그 수정(낭비·위반)은 검증 불필요 — 바로 고치고 커밋.
2. **가중치 격리(가장 흔한 함정).** head2head는 `server/ai/aiWeights.candidate.json`이 존재하면 챌린저가 그 가중치를 써서(`weightsDiffer=true`) 플래그 효과가 오염된다. **플래그만 보려면 반드시 `AI_CHALLENGER_WEIGHTS=server/ai/aiWeights.json`로 챔피언 가중치를 고정**하고 돌린다. 리포트의 `weightsDiffer`가 `false`인지 매번 확인.
3. **경계값은 판수로 굳힌다.** 60판에서 p≈0.05~0.2의 "유망" 결과는 **평균 회귀로 뒤집히기 쉽다**(실측: 60판 +3.3VP → 120판 −1.5VP). 경계면 120판 이상으로 재확인 후 결정.
4. **채택 기준 = "음수만 거른다"(2026-06-18 사용자 합의).** VP 분산이 게임당 ±20이라 **+3 VP짜리 작은 효과는 그룹당 ~340판(총 ~680게임) 없이는 p<0.05 증명 불가** — 측정력이 근본적으로 부족하다. 따라서 `p<0.05` 요구는 작은 전략 개선엔 부적합한 잣대. 실질 기준:
   - **채택**: VP 마진이 **음수가 아니고**(0 이상), 방향이 일관 양성이거나 무해이며, **도메인 지식상 옳은** 변경. 유의성 미달이어도 채택.
   - **기각**: VP가 **명확히 음수 방향**(fedSatHumanCap −2.99, fedCompactBuild −4.22처럼 — 큰 손해는 적은 판수로도 잡힘). **측정의 진짜 역할 = "확실한 손해 거르기"**, "작은 이득 정밀 증명"이 아님.
   - winner's curse 주의: 첫 측정의 큰 양수는 평균회귀로 거의 내려간다(+4.57→+2.8). 첫 수치를 믿지 말고 **부호와 안정성**(기준선 일관성)을 보라.
   - ★ **행동 검증도 병행**: VP뿐 아니라 플래그가 **실제로 봇의 선택을 바꾸는지**(빌드 타깃·액션) 확인. 안 바뀌면 어떤 전략도 안 먹힘 — 점수가 후보에서 안 통하거나 MCTS가 덮는 구조 문제일 수 있음.
5. **대칭 버그는 비교를 편향시키지 않는다.** 공용 베이스 코드의 버그는 챔피언·챌린저 양쪽에 동일하게 작용 → 상대 비교(채택/기각)의 방향은 유효. 단 절대 점수는 낮아지고 신호가 묻힐 수 있으니, 버그를 고친 뒤엔 채택했던 변경을 재검증.
6. **플래그로 게이팅, 기본 OFF.** 새 행동은 `getPlayerFlag(playerId, 'flagName', false)`로 감싸고 `server/ai/challenger.flags.json`에 `{"flagName": true}`로 켜서 A/B. 채택 시 기본값을 `true`로 바꾸고 challenger.flags를 `{}`로 되돌려 커밋.

## 루프 (한 사이클)

1. **약점 찾기 (로그 분석)**
   - 종족별 평균 점수 랭킹 → 최하위부터. (`scripts/faction-scores.mjs`)
   - 나쁜 패턴 탐지: 지식 안 쓰고 패스 / 사거리 부스터 낭비 / 연방 sprawl(위성 과다) / 자원 쟁여두기 등. (`scripts/bad-patterns.mjs`, 사람 게임 로그 `data/human-games/*.json` 대상)
   - 사용자 관찰도 1급 신호 — 재현 가능한 룰 위반/낭비는 즉시 버그로 처리.
2. **가설 + 구현** — `server/ai/`(bot.ts / federationPlanner.ts / evaluator.ts)에 플래그 게이팅으로. 빌드는 `npx tsc --noEmit && npm run build`.
3. **검증** — `scripts/run-h2h.sh <flag>` (가중치 격리 + 워커 6 + 좀비 정리 + 전체출력). 종족 랭킹도 그 출력에서 같이 뽑힘.
4. **결정 + 기록** — 채택/기각을 `DECISIONS.md`에 한 줄 추가(플래그·판수·승률·VP·p·판정). 채택이면 기본값 ON 커밋. 기각이면 플래그 OFF 유지 또는 코드 되돌림.

## 도구

| 파일 | 용도 |
|------|------|
| `scripts/run-h2h.sh` | head2head 실행 래퍼 — 가중치 격리·워커6·좀비 정리·전체출력 보존. `bash run-h2h.sh <challengerFlagsJson> [games]` |
| `scripts/faction-scores.mjs` | head2head/self-play 출력에서 종족별 평균 점수 집계. `node faction-scores.mjs <output-file>` |
| `scripts/bad-patterns.mjs` | 사람 게임 로그(data/human-games)에서 연방 위성수·파워액션 분포 등 봇 vs 사람 비교 |
| `DECISIONS.md` | 시도한 모든 전략 + head2head 결과 + 판정(채택/기각) 누적 — **같은 실패 반복 방지**. 새 실험 전 먼저 읽기. |
| `reference/bot-map.md` | 봇 코드 구조(핵심 함수 위치)·로그 포맷·종족 메모 |
| `reference/head2head.md` | head2head 동작·환경변수·함정 상세 |

## 운영 함정 (실측)

- **좀비 프로세스**: head2head를 `TaskStop`으로 중단하면 Windows에서 워커 서버(`npx tsx server/index.ts`)가 고아로 남아 CPU/포트를 잡는다. `run-h2h.sh`가 시작 전 정리하지만, 수동 정리는 `reference/head2head.md` 참고. 가능하면 완주시킬 것.
- **풀게임 = 느림**: 봇이 정상이면 6라운드 끝까지 플레이 → 게임당 길다. 120판은 워커6로 ~30~40분. (봇이 일찍 패스하던 버그가 있을 땐 빨랐던 것 — 빠르면 오히려 의심.)
- **24코어**: 워커 6 동시도 각 게임 MCTS 400ms 품질 유지. 단 동시 head2head는 최대 2개(포트/리포트 분리: `H2H_BASE_PORT`, `H2H_REPORT`).

## 자세히

- 봇 의사결정 진입점·평가·플래그·연방플래너 위치: `reference/bot-map.md`
- head2head 환경변수·판정 해석: `reference/head2head.md`
- 지금까지의 채택/기각 전부: `DECISIONS.md`
