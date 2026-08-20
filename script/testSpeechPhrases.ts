/**
 * 음성 안내 문구 스모크 — 실제 로그에 나오는 액션 문자열을 넣어 무엇으로 읽히는지 확인한다.
 * speech.ts는 window가 없으면 재생을 건너뛰므로 Node에서 문구 변환만 검증할 수 있다.
 *
 * 실행: npx tsx script/testSpeechPhrases.ts
 */
import { actionParts, whoLabel } from '../client/src/lib/speech';

const CASES: Array<[string, string, string?]> = [
	['Entered Ship', 'Rebellion · 10VP → 5VP (-5)'],
	['Entered Ship', 'Twilight · 10VP → 5VP (-5)'],
	['Entered Ship', 'Eclipse · 6VP → 1VP (-5)'],
	['Entered Ship', 'TF Mars · 13VP → 8VP (-5), 1QIC'],
	['Rebellion: 3K → 2Q 3C', ''],
	['Rebellion: Gain tech tile', '3 QIC (choose tile + track advance)'],
	['Rebellion: Mine → TS', '1O, 3P'],
	['Twilight: TS → Research Lab', '2O, 3P'],
	['Twilight: +3 Range', ''],
	['Twilight: Federation benefit', ''],
	['Eclipse: 4K+2P → Research', ''],
	['Eclipse: 6C → Build mine on asteroid', ''],
	['Eclipse: Planet types + 3 VP', ''],
	['TF Mars: Gaia Project', ''],
	['TF Mars: 3C → 2 Terraform', ''],
	['TF Mars: Tech tiles + 2 VP', ''],
	['Built Mine', 'on desert (1O, 2C)'],
	['Built Mine on Proto', 'on proto'],
	['Built Mine on Asteroid', ''],
	['Built Parasitic Mine', '1O, 2C (Lantida)'],
	['Upgraded to Trading Station', ''],
	['Upgraded to Research Lab', ''],
	['Upgraded to Planetary Institute', ''],
	['Upgraded to Academy', '6O, 6C (1QIC 액션)'],
	['Upgraded to Academy (Bescods/매안)', '6O, 6C (2K 수익)'],
	['Academy (Right)', '1 QIC (Special Action)'],
	['Academy (Right)', '4 C (Special Action)'],
	['Advanced Research', 'navigation → Lv.3'],
	['Advanced Research', 'terraforming → Lv.2'],
	['Advanced Research', 'artificialIntelligence → Lv.1'],
	['Placed Gaiaformer', 'on Transdim'],
	// 파워/기술/보너스 액션 — details 문구는 server/gameState.ts 의 실제 값을 그대로 쓴다
	['Power Action', '+1 Terraform step (3P)'],
	['Power Action', '+2 Terraform steps (3P)'],
	['Power Action', '+3 Knowledge (4P)'],
	['Power Action', '+2 Knowledge (4P)'],
	['Power Action', '+2 Ore (3P)'],
	['Power Action', '+7 Credits (4P)'],
	['Power Action', '+2 Power tokens (3P)'],
	['Power Action', ''],
	['Used Tech Action', 'Gained 4 Power'],
	['Used Tech Action', 'Gained 3 Knowledge'],
	['Used Tech Action', 'Gained 3 Ore'],
	['Used Tech Action', 'Gained 1 QIC and 5 Credits'],
	['Used Tech Action', 'Gained 4 Power (via Special Action)'],
	['Used Tech Action', ''],
	['Bonus Action', '1 Terraform Step'],
	['Bonus Action', 'Gaia Project'],
	['Bonus Action', '+3 Range'],
	['Federation', ''],
	['Ivits: Space Station', 'Placed'],
	['Firaks: Downgrade', 'Lab→TS'],
	['Ambas: Special', 'PI ↔ Mine 위치 교체'],
	['Pass', ''],
	// 타클론 파워 태우기·브레인스톤은 프리액션 → 무음
	['Taklons: Burn (B+T)', 'Brain(2) + 1 token -> Brain(3)'],
	['Taklons: Brain Stone', 'Moved to Gaia (until next round)'],
	// 기술 타일 획득 — 무엇을 먹고 어떤 트랙을 올렸는지 (tileId가 3번째 인자)
	['Gained Tech Tile', 'economy → Lv.2', 'tech-big-4str'],
	['Gained Tech Tile', 'terraforming → Lv.3', 'tech-imm-7vp'],
	['Gained Tech Tile', 'science stays L4 (max)', 'tech-act-4p'],
	['Gained Tech Tile', 'gaiaProject → Lv.2', 'tech-inc-1k-1c'],
	['Rebellion: Gained Tech Tile', 'navigation → Lv.3', 'tech-gaia-3vp'],
	['Bot: Gained Tech Tile', 'tech-imm-1o-1q, economy → Lv.1'],
	['Advanced Tech Tile', 'Covered tech-act-4p → adv-act-3k · +3 VP', 'adv-act-3k'],
	['Advanced Tech Tile', 'Covered tech-inc-4c → adv-pass-3vp-fed', 'adv-pass-3vp-fed'],
	['Gained Tech Tile', 'economy → Lv.2', 'tech-unknown-99'],
	// 게임 시작 때 첫 보너스 타일 선택 — 패스가 아니다
	['Selected Bonus Tile', '4P | 4VP/Big'],
	['Selected Bonus Tile', '2C | ACT: TF'],
	['Selected Bonus Tile', 'bon-1o-1k'],
	// 패스 — 어떤 보너스 타일을 집었는지
	['Selected Bonus', 'Returned bon-2c-1q, took bon-2c-terraform'],
	['Selected Bonus', 'Returned bon-1o-mine, took bon-1o-gaiaformer'],
	['Selected Bonus', 'Returned bon-4c-gaia, took bon-unknown-9'],
	['Selected Bonus', ''],
	// 고른 트랙만 남는 후속 로그
	['Eclipse: Research', 'terraforming → Lv.3 (2K+3P)'],
	['Advanced Tech: Advanced track', 'artificialIntelligence → Lv.1'],
	['Eclipse: Research', ''],
	// 연방 보상 — 로그 문구가 두 형식으로 섞여 있다
	['Federation Reward', '+7VP +2O'],
	['Federation Reward', '7 VP 2O'],
	['Federation Reward', '+12VP'],
	['Federation Reward', '8 VP 1 QIC'],
	['Federation Reward', '+8VP +2PW'],
	['Federation Reward', '4 VP 1Q 2O'],
	['Federation Reward', '8 VP 8C'],
	['Federation Reward', '4VP 4K'],
	['Federation Reward', '7 VP +2Tokens'],
	['Federation Reward', 'Free Mine (3 Terraform)'],
	['Federation Reward', 'Tech Tile'],
	// 우주선 기술타일 — 배에서 얻거나 기술 연방 보상으로
	['Ship Tech: 1O 3K', '+1 Ore, +3 Knowledge'],
	['Ship Tech: 2TF+Mine', '2 terraform steps, next mine free'],
	['Ship Tech: Nav+1', 'Permanent +1 range'],
	['Ship Tech: Advanced track', 'economy → Lv.2'],
	// 아래는 '무음'이어야 하는 결과성·부수 로그
	['Rebellion: Gained Tech Tile', 'navigation → Lv.3'],
	['Eclipse: Built mine on asteroid', ''],
	['Twilight: Spaceship Fed', ''],
	['Free Actions', '1O → 1C'],
	['Undo Free Action', ''],
	['Round Start', ''],
];

let spoken = 0, silent = 0;
for (const [a, d, tile] of CASES) {
	const parts = actionParts(a, d, tile);
	const who = whoLabel('bal_tak', '시리');
	const r = parts ? [who, ...parts].filter(Boolean).join(' ') : null;
	if (r) spoken++; else silent++;
	console.log((r ?? '— 무음 —').padEnd(34) + '←  ' + a + (d ? `  [${d.slice(0, 34)}]` : '') + (tile ? `  {${tile}}` : ''));
}
console.log(`
읽음 ${spoken}건 · 무음 ${silent}건`);
