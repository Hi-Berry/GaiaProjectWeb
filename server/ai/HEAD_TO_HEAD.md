# Head-to-head A/B 측정 하니스

봇이 정말로 강해졌는지 **신뢰성 있게** 측정한다. 기존 self-play/validate-ai는 두 버전을
따로 돌려 평균 VP를 비교했는데, 4인 동일봇 평균 VP는 노이즈(±5)가 커서 실력차를 못 잡았다.
이 하니스는 **챔피언 2명 + 도전자 2명을 같은 테이블**에 앉히고, 좌석 배정을 6패턴으로
순환시켜 선플레이어/위치 편향을 상쇄한 뒤, **도전자 승률 + VP 마진**을 유의성 검정과 함께 보고한다.

## 빠른 사용

```bash
npm run head2head            # 기본 60게임, 워커 3개 (서버는 러너가 직접 띄움)
npm run head2head:quick      # 24게임, MCTS 400ms (빠른 확인용)
H2H_GAMES=120 npm run head2head
```

리포트: `data/h2h-report.json` (콘솔에도 요약 출력).

## 무엇을 비교하나 — 두 축

### 1) 가중치(weights) 변경
`evaluator.ts`의 가중치 숫자만 바꾸는 경우.
- 챔피언: `server/ai/aiWeights.json`
- 도전자: `server/ai/aiWeights.candidate.json` (없으면 챔피언과 동일 가중치로 둠)

```bash
AI_CHALLENGER_WEIGHTS=server/ai/aiWeights.candidate.json npm run head2head
```

### 2) 코드(로직) 변경 — 기능 플래그로 게이팅
백로그 대부분(우주선 후보 재배치, TOP_N, 커버타일 선택 등)은 **코드 변경**이라 가중치 JSON
교체로는 A/B가 안 된다. 그래서 신규 코드 경로를 **좌석별 플래그**로 감싼다:

```ts
// bot.ts / federationPlanner.ts 안에서
import { getPlayerFlag } from './variant';

if (getPlayerFlag(playerId, 'shipReorder', false)) {
    // ...신규 경로 (도전자)...
} else {
    // ...기존 경로 (챔피언)...
}
```

그리고 도전자 플래그 파일에서 켠다 — `server/ai/challenger.flags.json`:
```json
{ "shipReorder": true }
```

```bash
npm run head2head   # challenger.flags.json 자동 사용
# 또는
AI_CHALLENGER_FLAGS=server/ai/myflags.json npm run head2head
```

플래그가 head-to-head에서 이기면 → 코드에서 기본값을 신규 경로로 바꾸고(또는 플래그 제거),
챔피언으로 승격. 지면 → revert. **모든 변경은 이 하니스를 통과해야 채택한다.**

## 결과 읽는 법

```
도전자 승률: 58.3%  (B 28 : A 20, 95%CI 44~71%, p=0.151)
평균 VP: 챔피언 132.4 vs 도전자 138.1
VP 마진(도전자-챔피언): +5.70 ± 2.10 (p=0.012)
판정: ✅ 도전자가 더 강함 (유의)
```

- **도전자 승률**: 매 게임 최고점자가 어느 그룹인지. 50% 초과 + p<0.05 → 도전자 우세.
- **VP 마진**: 게임별 (도전자 평균 − 챔피언 평균). 부호와 p값을 본다.
- **판정**: 승률 또는 마진 중 하나라도 유의(p<0.05)하고 방향이 맞으면 채택 권고.
- 판수가 적으면(<10 결정) "판수 부족". 보통 **60판 이상**, 미묘한 변경은 120판+ 권장.

> 팁: 챔피언=도전자(완전 동일)로 한 번 돌리면 **A/A 노이즈 기준선**이 나온다. 승률이 ~50%,
> 마진이 ~0 근처로 나와야 정상 — 하니스 자체의 편향 점검용.

## 동작 원리 (요약)

- `server/ai/variant.ts` — 좌석(playerId)별 변형 레지스트리(가중치+플래그). 순환참조 없음.
- `evaluator.ts` — 평가 시 좌석별 가중치를 우선 사용(없으면 전역).
- `botHandler.ts` — `setBotDelayMs(0)`으로 봇 턴 지연 제거(자기대국 가속, 로직 불변).
- `gameState.ts` `auto_setup_test({ headToHead })` — 턴순서 위치별로 A/B 변형 주입, 결과에 그룹 태깅.
- `server/ai/headToHead.ts` — 서버 N개 부팅 → 게임 실행 → 집계/검정 → 리포트.
