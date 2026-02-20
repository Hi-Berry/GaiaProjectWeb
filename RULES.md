# Gaia Project Web — 수정 시 반드시 지켜야 할 규칙 (RULES)

코드 수정 시 **절대 깨지면 안 되는** 동작과 규칙을 정리한 문서입니다.  
새 기능/버그 수정 시 이 파일을 참고하고, 여기 적힌 동작이 바뀌지 않도록 하세요.  
**본인이 추가로 고정하고 싶은 항목은 하단 "추가 고정 목록"에 편집해서 넣으세요.**

---

## 1. 게임 상태·플로우 (절대 깨면 안 됨)

### 1.1 턴/메인 액션

- **`hasDoneMainAction`**
  - 서버에서 **한 턴에 메인 액션 1회** 제한용. `true`면 `build_mine`, `upgrade_structure`, `use_ship_action` 등 메인 액션 핸들러는 **맨 앞에서 return**해야 함.
  - **예외(hasDoneMainAction 체크 하지 말아야 하는 경우):**
    - **우주선 기술 타일 보상 후 트랙 1칸 진행** (`advance_tech`): `pendingShipTechTrackAdvance`가 있으면 **먼저** 처리하고, 이때는 `hasDoneMainAction`으로 막지 말 것.
    - **트왈라잇 1K (+3 거리)** 사용 후: 같은 턴에 광산/가이아포밍을 허용하므로, 해당 우주선 액션에서는 `hasDoneMainAction = true` **설정하지 말 것**.

### 1.2 거리/파워 보너스 (한 번 쓰면 소모)

- **`tempRangeBonus`** (트왈라잇 1K: +3 거리)
  - 적용하는 곳: **광산 건설**(일반/가이아/프로토 **및 소행성**), 우주선 입장 시 거리 계산.
  - **사용 시 반드시 소모:** `baseRange += 3` 한 뒤 **같은 핸들러 안에서** `player.tempRangeBonus = false` 할 것. (한 행동에만 적용)
- **`rangeBonusActive`** (보너스 타일 +3 거리)
  - 마찬가지로 적용한 뒤 **한 번 쓰면** `player.rangeBonusActive = false` 로 소모할 것.
- 소행성 광산 건설도 위 두 보너스를 **반드시** 적용·소모해야 함. (소행성만 별도 거리 계산하면 안 됨)

### 1.3 가이아 프로젝트 트랙 → 가이아포머

- **트랙 레벨 1 도달 시:** `applyTrackLevelBonus` 안에서 **가이아포머 +1** 지급해야 함. (게임 시작 시만이 아니라 **플레이 중 4K로 0→1 올렸을 때도**)
- 레벨 2: 파워 3개, 레벨 3: 가이아포머 +2, 레벨 4: 가이아포머 +3 — 이 보상 규칙 변경/삭제 금지.

### 1.4 파워 수신 (다른 플레이어 건물 옆 건설 시)

- **시작 건물(집 배치) 후 첫 수익 단계:** 보너스 타일 선택이 모두 끝나고 `triggerIncomePhase` 호출 **직전**에 `createPowerOffersForAllStructures(game)` 호출할 것. 그래야 하이브/팅커로이드 등 인접 시 파워 제안이 생기고, 수익 창에 **파워 수신 + 자동 받기** 버튼이 뜸.
- `createPowerOffers`는 건물 짓거나 업그레이드할 때만 호출되는데, **시작 건물은** `place_starting_mine`에서 호출하지 않으므로, 위 "전체 구조물 기준 파워 제안 생성"이 **반드시** 필요함.

### 1.5 수익 단계 + 파워 수신 UI

- 수익 선택 창(`pendingIncomeOrder`)이 떠 있을 때, **미처리 파워 제안**이 있으면 같은 창 안에 **파워 수신** 블록과 **자동 받기 (최적 순서로 모두 수락)** 버튼이 **반드시** 노출되어야 함. (클라이언트에서 `pendingPowerOffers`와 `pendingIncomeOrder` 둘 다 보고 표시)

---

## 2. 우주선·기술 타일 (절대 깨면 안 됨)

### 2.1 트왈라잇 1K (+3 거리)

- 사용 시: `player.tempRangeBonus = true` 설정.
- **같은 턴**에 광산 건설/가이아포밍 등에서 위 1.2대로 +3 적용 후 **한 번 쓰면 소모** (위 규칙 위반 시 "메시지는 3 올라갔는데 QIC 계속 나감" 현상 발생).

### 2.2 리벨리온 3Q / 연구소 건설 시 기술 타일 선택

- **선택지 범위:** "우주선 기술 타일만" 또는 "메인보드만"이 아니라 **6트랙 + 풀 3개 + 입장한 우주선 기술 타일** 모두 선택 가능해야 함.
- 서버:
  - 리벨리온 3Q: `game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId)` 설정 (undefined 하면 우주선 타일이 선택지에 안 뜸).
  - 연구소 건설(트왈라잇 2번, 리벨리온 2번): 동일하게 우주선 타일 ID 목록 넣어 주고, 클라이언트에서 **트랙+풀+우주선** 전부 표시.
- 클라이언트(ResearchBoard): 기술 타일 선택 시 **항상 6트랙 + 풀**을 보여주고, `availableShipTechTileIds?.length`가 있으면 **추가로** "우주선 기술 타일" 섹션 표시. (우주선만 보이거나 트랙+풀이 빠지면 안 됨)

### 2.3 우주선 기술 타일 획득 후 트랙 1칸 진행

- 서버: `select_tech_tile`에서 우주선 전용 기술 타일 선택 시 `game.pendingShipTechTrackAdvance = { playerId }` 설정. 이후 **`advance_tech`** 가 호출되면:
  - **맨 앞에서** `pendingShipTechTrackAdvance`인지 확인하고, 해당 플레이어면 **`hasDoneMainAction` 체크 없이** 트랙 1칸 진행 처리 후 return.
- 클라이언트: R창에 "우주선 기술 타일 보상 — 6개 트랙 중 하나를 선택하세요" 안내와 트랙 버튼이 떠 있고, 클릭 시 `GameClient.advanceTech(gameId, trackId)` 호출. 이 플로우가 막히면 "버튼/트랙 눌러도 무반응"이 됨.

---

## 3. 서버 핸들러 순서/체크 (요약)

- **`advance_tech`:**  
  `pendingShipTechTrackAdvance` 처리 → (그 다음에) `hasDoneMainAction` return → 4K 트랙 진행.
- **`build_mine`:**  
  거리 계산 시 `tempRangeBonus` / `rangeBonusActive` 적용하고 **즉시 소모**. 소행성 분기에서도 동일 적용.
- **보너스 타일 선택 완료 → 메인 단계 진입:**  
  `triggerIncomePhase(game)` 호출 **전에** `createPowerOffersForAllStructures(game)` 호출.

---

## 4. 클라이언트 (요약)

- 연구 보드에서 **파워 액션** 사용 시: 파워/QIC 부족이면 토스트만 띄우고 **연구 보드 닫지 말고** 서버 호출 하지 말 것. (닫기/서버 호출은 리소스 충분할 때만)
- 수익 단계 다이얼로그: `pendingPowerOffers`(해당 플레이어 미처리)가 있으면 **파워 수신** 블록 + **자동 받기** 버튼 표시 유지.

---

## 5. 추가 고정 목록 (직접 편집)

아래는 **본인이 수정 시 절대 깨지 말아야 할 것**을 적어 두는 칸입니다.  
항목을 추가·수정한 뒤 저장해 두면, 이후 수정 시 참고할 수 있습니다.

- (예: Ores는 0 미만이 되면 안 됨 — clamp 등으로 보정)
- (예: 턴 순서는 turnOrder 배열 순서를 바꾸지 말 것)
- 

---

## 6. 관련 파일 (수정 시 주의)

| 목적           | 파일 |
|----------------|------|
| 게임 규칙/상수 | `shared/gameConfig.ts` |
| 턴/액션/보상   | `server/gameState.ts` (거리, 가이아포머, 파워 제안, pending* 플로우) |
| 연구 보드/기술 | `client/src/components/ResearchBoard.tsx` |
| 수익/파워 UI   | `client/src/pages/Game.tsx` (수익 다이얼로그, 파워 수신, 연구 보드 열기) |
| 게임 상태 소비 | `client/src/lib/gameClient.ts` (emit 이벤트 이름은 서버와 일치 유지) |

이 문서를 수정할 때는 **기존 항목의 의미를 바꾸지 말고**, 추가만 하거나 문구만 명확히 하는 것을 권장합니다.
