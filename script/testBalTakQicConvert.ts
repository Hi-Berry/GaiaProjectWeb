/**
 * 회귀 테스트: 발타크 '포머 → QIC' 자동 변환이 기대한 만큼만 나오는가.
 *
 * 사용자 요청(2026-08-13): "발타크가 QIC 액션 눌렀을 때 자동으로 QIC 부족한 만큼 포머에서 변환"
 *
 * 클라 확인창은 `보유 포머 − 이번 라운드 잠금분 >= 부족분` 일 때만 뜨고, OK를 누르면 부족분만큼
 * executeBalTakGaiaformerToQic을 연달아 호출한다. 그 전제(연속 호출이 실제로 그만큼 QIC를 주고,
 * 남은 포머가 없으면 실패로 멈춘다)를 서버 함수로 직접 검증한다.
 *
 * 사용: PORT=5096 npx tsx script/testBalTakQicConvert.ts
 */
import { executeBalTakGaiaformerToQic, getEffectiveGaiaformers } from '../server/gameState';

const ioStub: any = { to: () => ({ emit: () => { } }), emit: () => { } };
const ME = 'p_bt';

function mk(gaiaformers: number, locked: number, qic: number, faction = 'bal_tak') {
	const player: any = {
		name: 'BT', faction, ore: 0, credits: 0, knowledge: 0, qic,
		power1: 0, power2: 0, power3: 0, research: {}, techTiles: [], coveredTechTiles: [],
		gaiaformers, balTakGaiaformersUsedForQic: locked,
	};
	const game: any = {
		id: 'g', currentPhase: 'main', players: { [ME]: player }, turnOrder: [ME],
		currentPlayerIndex: 0, roundNumber: 3, gameLog: [], gameLogSeq: 0, map: [],
	};
	return { game, player };
}

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failed++;
};

/** 클라 확인창이 쓰는 여유 포머 계산 (Game.tsx의 balTakSpareGaiaformers와 동일 정의) */
const spare = (p: any) => Math.max(0, (p.gaiaformers ?? 0) - (p.balTakGaiaformersUsedForQic ?? 0));

// ① 여유 포머 계산이 서버 getEffectiveGaiaformers와 일치해야 한다 (불일치하면 확인창이 거짓말을 한다)
for (const [gf, lock] of [[3, 0], [3, 1], [2, 2], [1, 3], [0, 0]]) {
	const { player } = mk(gf, lock, 0);
	check(`여유 포머 일치 (보유 ${gf}, 잠금 ${lock})`, spare(player) === getEffectiveGaiaformers(player),
		`클라 ${spare(player)} vs 서버 ${getEffectiveGaiaformers(player)}`);
}

// ② 부족분만큼 연속 변환하면 정확히 그만큼 QIC가 늘고 포머가 잠긴다
{
	const need = 3;                       // 3Q 액션인데 QIC 1개뿐 → 2개 부족
	const { game, player } = mk(3, 0, 1);
	const converts = need - player.qic;
	let allOk = true;
	for (let i = 0; i < converts; i++) if (!executeBalTakGaiaformerToQic(ioStub, game, ME)) allOk = false;
	check('부족분 2개 변환', allOk && player.qic === need && player.balTakGaiaformersUsedForQic === 2 && getEffectiveGaiaformers(player) === 1,
		`qic=${player.qic} 잠금=${player.balTakGaiaformersUsedForQic} 여유=${getEffectiveGaiaformers(player)}`);
}

// ③ 여유 포머를 넘어서는 변환은 실패한다 (확인창이 뜨지 않아야 하는 상황)
{
	const { game, player } = mk(1, 0, 0);
	check('여유 1개 — 1회는 성공', executeBalTakGaiaformerToQic(ioStub, game, ME) === true, `qic=${player.qic}`);
	check('여유 소진 후 추가 변환은 실패', executeBalTakGaiaformerToQic(ioStub, game, ME) === false, `qic=${player.qic}`);
	check('실패해도 QIC가 늘지 않음', player.qic === 1, `qic=${player.qic}`);
}

// ④ 이미 라운드에 다 써서 잠긴 상태면 아예 불가
{
	const { game, player } = mk(2, 2, 0);
	check('잠금 = 보유면 변환 불가', executeBalTakGaiaformerToQic(ioStub, game, ME) === false && player.qic === 0);
	check('확인창도 안 뜸(여유 0)', spare(player) === 0);
}

// ⑤ 발타크가 아니면 동작하지 않는다
{
	const { game, player } = mk(3, 0, 0, 'terran');
	check('타 종족은 변환 불가', executeBalTakGaiaformerToQic(ioStub, game, ME) === false && player.qic === 0);
	check('타 종족은 여유 0으로 취급', spare({ ...player, gaiaformers: 0 }) === 0);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 부족분만큼만 변환되고, 여유가 없으면 확인창이 뜨지 않습니다.');
process.exit(0);
