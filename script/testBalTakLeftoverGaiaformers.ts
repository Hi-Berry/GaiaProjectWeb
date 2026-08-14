/**
 * 회귀 테스트: 발타크의 남은 가이아포머가 종료 잔여 자원 정산에 들어가는가.
 *
 * 사용자 지적(2026-08-14): "발타크 잔여 자원에는 포머를 QIC로 바꿔서 결국 /3 점수에 들어가야 하는데
 *   없다면 누락이긴 해."
 *
 * 포머→1QIC는 프리액션이라 마지막 패스 직전에 언제든 누를 수 있다. 정산에 안 넣으면
 * '패스 전에 N번 눌러야 손해를 안 보는' 숨은 조작을 요구하게 된다 → 누르든 안 누르든 같은 점수가 되게 한다.
 *
 * 이중계산 함정: 이미 QIC로 바꾼 분(balTakGaiaformersUsedForQic)은 p.qic에 들어가 있으므로
 * 남은 포머에서 빼야 한다. 그 경계를 특히 본다.
 *
 * 사용: PORT=5093 npx tsx script/testBalTakLeftoverGaiaformers.ts
 */
import { endgameLeftoverUnits, type GaiaGameState } from '../shared/gameConfig';

const ME = 'p1';
function mk(o: { faction?: string; gf?: number; locked?: number; qic?: number; onMapGf?: number }) {
	const player: any = {
		name: 'T', faction: o.faction ?? 'bal_tak',
		ore: 0, credits: 0, knowledge: 0, qic: o.qic ?? 0,
		power1: 0, power2: 0, power3: 0, research: {}, techTiles: [], federations: [],
		gaiaformers: o.gf ?? 0, balTakGaiaformersUsedForQic: o.locked ?? 0,
	};
	const map: any[] = [];
	for (let i = 0; i < (o.onMapGf ?? 0); i++) map.push({ id: `m${i}`, q: i, r: 0, type: 'transdim', hasGaiaformer: true, gaiaformerOwnerId: ME });
	return { id: 'g', players: { [ME]: player }, map } as never as GaiaGameState;
}
const units = (g: GaiaGameState) => endgameLeftoverUnits(g, ME, (g as any).players[ME]);

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failed++;
};

console.log('① 남은 포머가 유닛으로 들어간다');
check('포머 3개 = 3유닛', units(mk({ gf: 3 })) === 3, String(units(mk({ gf: 3 }))));
check('포머 0개 = 0유닛', units(mk({ gf: 0 })) === 0);

console.log('\n② 이미 QIC로 바꾼 분은 빼야 한다 (이중계산 방지)');
// 포머 3개 중 2개를 이미 QIC로 바꿨다 → qic 2 + 남은 포머 1 = 3유닛 (총량은 바꾸기 전과 같아야 한다)
check('바꾸기 전: 포머3 = 3유닛', units(mk({ gf: 3, locked: 0, qic: 0 })) === 3);
check('2개 바꾼 뒤: qic2 + 포머1 = 3유닛', units(mk({ gf: 3, locked: 2, qic: 2 })) === 3, String(units(mk({ gf: 3, locked: 2, qic: 2 }))));
check('전부 바꾼 뒤: qic3 + 포머0 = 3유닛', units(mk({ gf: 3, locked: 3, qic: 3 })) === 3, String(units(mk({ gf: 3, locked: 3, qic: 3 }))));

console.log('\n③ 맵에서 가이아포밍 중인 포머는 제외 (p.gaiaformers에 없음)');
check('맵 포머 2개는 안 셈', units(mk({ gf: 1, onMapGf: 2 })) === 1, String(units(mk({ gf: 1, onMapGf: 2 }))));

console.log('\n④ 다른 종족은 영향 없음');
check('테란 포머 3개는 유닛 아님', units(mk({ faction: 'terran', gf: 3 })) === 0, String(units(mk({ faction: 'terran', gf: 3 }))));

console.log('\n⑤ 점수 환산(3유닛 = 1VP)');
const vp = (n: number) => Math.floor(n / 3);
check('포머 3개 → +1VP', vp(units(mk({ gf: 3 }))) === 1);
check('포머 2개 + 기존 1유닛 → +1VP', vp(units(mk({ gf: 2, qic: 1 }))) === 1, String(units(mk({ gf: 2, qic: 1 }))));

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 남은 포머가 정산에 들어가고, 미리 바꿔둔 분과 이중계산되지 않습니다.');
process.exit(0);
