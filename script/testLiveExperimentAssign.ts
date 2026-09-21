/**
 * 회귀: 실게임 봇 좌석 A/B 배정(server/ai/liveExperiment.ts).
 *   - 실험 없음 → no-op(null, variant 미등록)
 *   - 실험 있음 → 같은 게임의 봇이 ON/OFF 교대 배정, ON만 플래그 읽힘, 플레이어 상태에 liveVariant 기록
 * 사용: npx tsx script/testLiveExperimentAssign.ts
 */
import { assignLiveBotVariant, loadLiveExperiment } from '../server/ai/liveExperiment';
import { getPlayerFlag, getPlayerVariant } from '../server/ai/variant';

let fail = 0;
const chk = (n: string, c: boolean) => { console.log(`  ${c ? 'OK  ' : '실패'} ${n}`); if (!c) fail++; };

process.env.LIVE_BOT_FLAGS = '{"name":"","flags":{}}'; // 빈 실험 = 비활성 (파일 무시)
{
	const g: any = { id: 'g-none', botPlayerIds: ['bot-x'], players: { 'bot-x': {} } };
	chk('비활성: loadLiveExperiment null', loadLiveExperiment() === null);
	chk('비활성: 배정 null + variant 없음', assignLiveBotVariant(g, 'bot-x') === null && getPlayerVariant('bot-x') === undefined);
	chk('비활성: 플레이어 상태 미변경', g.players['bot-x'].liveVariant === undefined);
}
process.env.LIVE_BOT_FLAGS = JSON.stringify({ name: 'testFlag', flags: { testFlag: true, testW: 2 } });
{
	const g: any = { id: 'g-ab-1', botPlayerIds: [], players: {} };
	const groups: string[] = [];
	for (const id of ['bot-1', 'bot-2', 'bot-3']) { g.players[id] = {}; g.botPlayerIds.push(id); groups.push(String(assignLiveBotVariant(g, id))); }
	chk('교대 배정(on/off/on 또는 off/on/off)', groups[0] !== groups[1] && groups[0] === groups[2]);
	const on = groups[0] === 'on' ? 'bot-1' : 'bot-2', off = groups[0] === 'on' ? 'bot-2' : 'bot-1';
	chk('ON 좌석만 플래그 true', getPlayerFlag(on, 'testFlag', false) === true && getPlayerFlag(off, 'testFlag', false) === false);
	chk('숫자 플래그 ON=2 / OFF=기본값', getPlayerFlag(on, 'testW', 1) === 2 && getPlayerFlag(off, 'testW', 1) === 1);
	chk('라벨 기록', getPlayerVariant(on)?.label === 'live:testFlag:on' && getPlayerVariant(off)?.label === 'live:testFlag:off');
	chk('플레이어 상태 liveVariant', g.players[on].liveVariant?.group === 'on' && g.players[off].liveVariant?.group === 'off' && g.players[on].liveVariant?.name === 'testFlag');
	// 게임별 시작 패리티가 갈려 좌석 순서 편향이 상쇄되는지(여러 gameId 중 on 시작·off 시작 둘 다 존재)
	const starts = new Set<string>();
	for (const gid of ['a', 'b', 'c', 'd', 'e', 'f', 'g1', 'h2']) { const gg: any = { id: gid, botPlayerIds: ['bot-z' + gid], players: { ['bot-z' + gid]: {} } }; starts.add(String(assignLiveBotVariant(gg, 'bot-z' + gid))); }
	chk('게임별 시작 그룹이 on/off 모두 등장', starts.has('on') && starts.has('off'));
}
console.log(fail === 0 ? '\n전부 통과' : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
