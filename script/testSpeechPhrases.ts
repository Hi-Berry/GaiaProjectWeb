/**
 * 음성 안내 문구 스모크 — 실제 로그에 나오는 액션 문자열을 넣어 무엇으로 읽히는지 확인한다.
 * speech.ts는 window가 없으면 재생을 건너뛰므로 Node에서 문구 변환만 검증할 수 있다.
 *
 * 실행: npx tsx script/testSpeechPhrases.ts
 */
import { actionPhrase } from '../client/src/lib/speech';

const CASES: Array<[string, string]> = [
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
	['Upgraded to Academy', ''],
	['Advanced Research', 'navigation → Lv.3'],
	['Advanced Research', 'terraforming → Lv.2'],
	['Advanced Research', 'artificialIntelligence → Lv.1'],
	['Placed Gaiaformer', 'on Transdim'],
	['Power Action', '3 power → 2 ore'],
	['Used Tech Action', ''],
	['Federation', ''],
	['Ivits: Space Station', 'Placed'],
	['Firaks: Downgrade', 'Lab→TS'],
	['Ambas: Special', 'PI ↔ Mine 위치 교체'],
	['Pass', ''],
	// 아래는 '무음'이어야 하는 결과성·부수 로그
	['Ship Tech: Advanced track', 'terraforming → Lv.1'],
	['Ship Tech: 1O 3K', ''],
	['Rebellion: Gained Tech Tile', 'navigation → Lv.3'],
	['Eclipse: Built mine on asteroid', ''],
	['Eclipse: Research', ''],
	['Twilight: Spaceship Fed', ''],
	['Gained Tech Tile', 'economy → Lv.2'],
	['Free Actions', '1O → 1C'],
	['Undo Free Action', ''],
	['Round Start', ''],
	['Selected Bonus', ''],
	['Federation Reward', ''],
];

let spoken = 0, silent = 0;
for (const [a, d] of CASES) {
	const r = actionPhrase(a, d, 'bal_tak', '시리');
	if (r) spoken++; else silent++;
	console.log((r ?? '— 무음 —').padEnd(28) + '←  ' + a + (d ? `  [${d.slice(0, 34)}]` : ''));
}
console.log(`\n읽음 ${spoken}건 · 무음 ${silent}건`);
