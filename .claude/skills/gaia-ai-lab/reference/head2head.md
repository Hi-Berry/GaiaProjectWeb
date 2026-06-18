# head2head 검증 가이드

`npm run head2head` = `tsx server/ai/headToHead.ts`. 챔피언(현행) 2석 + 도전자(변경) 2석을 같은 테이블에 앉히고, 좌석 6패턴 순환으로 위치 편향을 상쇄한 뒤 도전자 승률·VP마진을 유의성 검정과 함께 보고. 워커가 서버 프로세스를 직접 spawn해 병렬 진행.

## 핵심 환경변수

| 변수 | 기본 | 비고 |
|---|---|---|
| `AI_CHALLENGER_WEIGHTS` | candidate.json | **항상 `server/ai/aiWeights.json`(=챔피언)로 고정**해 가중치 격리. 안 하면 candidate 가중치가 섞여 오염. |
| `H2H_GAMES` | 60 | 경계 결과는 120+로 굳힘. |
| `H2H_MCTS_MS` | 500 | 보통 400. 낮추면 빠르지만 봇 약해짐(대칭이라 비교는 유효). |
| `H2H_WORKERS` | 3 | 24코어면 6 권장(처리량↑, 품질 유지). |
| `H2H_BASE_PORT` | 5300 | 동시 2런이면 다른 포트(예 5400)로 분리. |
| `H2H_REPORT` | data/h2h-report.json | 동시 2런이면 다른 경로로 분리. |
| `AI_CHALLENGER_FLAGS` | server/ai/challenger.flags.json | 챌린저 플래그 파일. run-h2h.sh가 이 기본 파일에 써넣음. |
| `H2H_FORCE_FACTION` | (없음) | **종족별 측정용.** 주면 그 종족을 고정좌석(`H2H_FORCE_FACTION_POS`, 기본 0)에 강제 배정. |
| `H2H_FORCE_FACTION_POS` | 0 | 강제 종족의 turn-order 위치(0~3). |

챔피언 플래그는 기본 `{}`(없음). 챌린저만 `challenger.flags.json`의 플래그가 켜진 상태로 비교됨.

## ★ 종족별 측정 (faction-forcing) — 2026-06-18 추가

종족 전용 변경(예 geodens 전략)은 **랜덤 배정이면 신호가 ~1/4로 희석**돼 120판으로도 유의차가 안 뜬다(expansionResearch가 전 종족 공통이라 측정됐던 것). 해결:

- `H2H_FORCE_FACTION=geodens` → 그 종족을 **고정좌석(pos 0)** 에 앉힌다. B_PATTERNS 6패턴 중 pos 0은 B 3회/A 3회 → **그 좌석이 절반은 B(플래그ON)/절반은 A(OFF)**.
- 결과 = **같은 종족·같은 고정좌석을 ON vs OFF로 paired 비교**(좌석/위치 편향 통제). 콘솔 `★ [faction] 플래그ON .. vs OFF .. → Δ.. (p≈..)` 줄과 리포트 `factionSplit`이 핵심 지표 — 전체 승률/마진은 비대상 좌석 때문에 희석되니 **이 줄을 봐야** 함.
- 래퍼: `bash run-h2h.sh '{"flag":true}' 120 400 6 geodens` (5번째 인자 = 강제 종족).
- 무편향 검증됨: flags `{}`+forceFaction이면 ON/OFF Δ≈0(p≈0.97).

### ⚠️ 래퍼 JSON 버그(수정함, 2026-06-18)
`FLAGS="${1:-{}}"`가 bash에서 `{"x":true}}`로 깨져 `challenger.flags.json` 파싱 실패 → `readJson(...) ?? {}`로 조용히 폴백(플래그 미적용). **리포트 `flagsDiffer:true` 매번 확인**(false면 챔피언끼리 무효 측정). 수정: `FLAGS="$1"; [ -z "$FLAGS" ] && FLAGS='{}'`.

## 리포트(data/h2h-report.json) 읽기

- `config.weightsDiffer` — **반드시 false** 확인(격리 됐는지). true면 결과 무효(가중치 오염).
- `bWins/aWins/draws`, `bWinRate`, `winPValue` — B=도전자(챌린저).
- `avgChampionVp / avgChallengerVp`, `vpMarginMean`(도전자−챔피언), `vpMarginPValue`.
- `verdict` — 자동 판정 문구.

판정 기준: 승률 p<0.05 + VP마진 양수 = **유의 향상**(채택). |마진|≈0·p≫0.05 = **무해**. VP 음수 방향 + 유의 = **약화**(기각). 경계(p≈0.05~0.2)는 판수 늘려 재확인.

## 종족 평균 같이 뽑기

head2head stdout의 게임별 라인(`A:faction=score | B:faction=score | ...`)을 보존하면 `scripts/faction-scores.mjs`로 종족 평균 집계 가능. **`tail`로 자르면 데이터 손실** — 전체 출력을 파일로 받을 것(run-h2h.sh는 자름 없음). 챔피언끼리(`{}`) 돌리면 가장 깨끗한 종족 자가대국.

## 좀비 정리 (TaskStop 후)

head2head를 중단하면 Windows에서 워커(`npx tsx server/index.ts`)가 고아로 남음. 정리(개발서버 watch·Cursor는 보존):

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*GaiaProjectWeb*' -and $_.CommandLine -like '*server/index.ts*' -and $_.CommandLine -notlike '*watch*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

`run-h2h.sh`가 시작 전 자동으로 이걸 한다. 가능하면 중단 말고 완주시킬 것.

## 시간 감

- 봇 정상(버그 없음)이면 6라운드 풀게임 → 게임당 길다. 워커6·120판 ≈ 30~40분. 너무 빠르면 봇이 일찍 패스하는 버그 의심.
- `tail -8 | ...` 파이프로 받으면 진행 중엔 출력이 안 보임(끝나야 flush). 진행률 보려면 파이프 없이 받거나 `grep "game N/"`.
