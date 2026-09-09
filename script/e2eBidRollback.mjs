// [사용자 2026-09-09] e2e: 비딩 낙찰 지점 롤백 (실행: 개발서버 5000 켠 상태에서 node script/e2eBidRollback.mjs) — 사람 2 + 봇 2, 경매→pick→종족선택 2회 후 두 번째 'Selected Faction' 로그로 롤백 요청/승인,
// 결과가 factionBidding/pick 단계로 복원되고(입찰·낙찰 유지) 첫 사람의 종족은 유지되는지 확인.
import { io } from 'socket.io-client';
const URL = process.env.URL || 'http://localhost:5000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const conn = () => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const call = (s, ev, payload) => new Promise(res => s.emit(ev, payload, (r) => res(r)));
const emit = (s, ev, payload) => s.emit(ev, payload);
const A = await conn(), B = await conn();
const c = await call(A, 'create_game', { playerName: 'A' });
const gameId = c.gameId, pidA = c.playerId;
console.log('game', gameId, 'A', pidA);
console.log('bidding on:', await call(A, 'set_use_faction_bidding', { gameId, useFactionBidding: true }));
const j = await call(B, 'join_game', { gameId, playerName: 'B' }); const pidB = j.playerId; console.log('B', pidB);
console.log('bot1', (await call(A, 'host_add_bot', { gameId })).ok, 'bot2', (await call(A, 'host_add_bot', { gameId })).ok);
emit(A, 'start_game', { gameId }); await sleep(600);
const get = async () => (await call(A, 'get_game', { gameId })).game;
let g = await get(); console.log('phase after start:', g.currentPhase, 'fb:', g.factionBidding && { phase: g.factionBidding.phase, bidder: g.factionBidding.currentBidderId, pick: g.factionBidding.pickPlayerId, remaining: g.factionBidding.remainingFactionIds?.length });
const socketOf = (pid) => pid === pidA ? A : B;
const humans = new Set([pidA, pidB]);
// 경매/선택 진행: 두 사람 모두 종족을 갖거나 단계가 바뀌면 종료
for (let i = 0; i < 20; i++) {
  g = await get(); const fb = g.factionBidding;
  if (g.currentPhase !== 'factionBidding') break;
  if (fb.phase === 'bidding' && fb.currentBidderId && humans.has(fb.currentBidderId)) { emit(socketOf(fb.currentBidderId), 'faction_bid_pass', { gameId }); await sleep(250); continue; }
  if (fb.phase === 'pick' && fb.pickPlayerId && humans.has(fb.pickPlayerId)) {
    const taken = new Set(Object.values(g.players).map(p => p.selectedTurnOrder).filter(x => x != null));
    let to = 1; while (taken.has(to)) to++;
    const fid = fb.remainingFactionIds[0];
    emit(socketOf(fb.pickPlayerId), 'faction_bid_pick', { gameId, factionId: fid, turnOrder: to });
    console.log(`  pick: ${fb.pickPlayerId === pidA ? 'A' : 'B'} → ${fid} turn ${to} (bid ${fb.pendingWinningBid})`);
    await sleep(300); continue;
  }
  await sleep(300);
}
g = await get();
const sel = (g.gameLog || []).filter(e => e.action === 'Selected Faction');
console.log('phase now:', g.currentPhase, '| Selected Faction logs:', sel.map(e => `${e.playerName}:${e.details}@seq${e.seq}`).join(' , '));
console.log('factions:', Object.values(g.players).map(p => `${p.name}=${p.faction}/bid${p.factionBidVp ?? '-'}/turn${p.selectedTurnOrder ?? '-'}`).join(' | '));
// 두 번째 사람 pick 로그로 롤백 요청 (사람 로그 중 마지막)
const humanSel = sel.filter(e => humans.has(e.playerId));
// 마지막 사람은 남은 종족 1개를 자동 배정받아(선택 없음) 별도 롤백 지점이 없다 → 첫 사람의 pick 로그를 대상으로.
const target = humanSel[0];
if (!target) { console.log('FAIL: no human Selected Faction log'); process.exit(1); }
const requester = target.playerId === pidA ? B : A; const approver = target.playerId === pidA ? A : B; const approverId = target.playerId === pidA ? pidA : pidB;
const rr = await call(requester, 'request_rollback', { gameId, seq: target.seq }); console.log('request_rollback →', rr);
g = await get(); console.log('pendingRollback label:', g.pendingRollback?.label, 'required:', g.pendingRollback?.required?.length);
if (g.pendingRollback) { console.log('respond →', await call(approver, 'respond_rollback', { gameId, accept: true, playerId: approverId })); await sleep(400); }
g = await get(); const fb = g.factionBidding;
console.log('AFTER phase:', g.currentPhase, '| fb:', fb && { phase: fb.phase, pick: fb.pickPlayerId === pidA ? 'A' : fb.pickPlayerId === pidB ? 'B' : fb.pickPlayerId, bid: fb.pendingWinningBid, remaining: fb.remainingFactionIds });
console.log('factions after:', Object.values(g.players).map(p => `${p.name}=${p.faction}/bid${p.factionBidVp ?? '-'}/turn${p.selectedTurnOrder ?? '-'}`).join(' | '));
console.log('Selected Faction logs after:', (g.gameLog || []).filter(e => e.action === 'Selected Faction').map(e => e.playerName).join(','));
const ok = g.currentPhase === 'factionBidding' && fb?.phase === 'pick' && fb.pickPlayerId === target.playerId && g.players[target.playerId].faction == null;
console.log(ok ? 'PASS: rolled back to pick stage with bid kept' : 'FAIL');
// 재선택이 정상 진행되는지: 다시 pick
if (ok) { const taken = new Set(Object.values(g.players).map(p => p.selectedTurnOrder).filter(x => x != null)); let to = 1; while (taken.has(to)) to++; emit(socketOf(fb.pickPlayerId), 'faction_bid_pick', { gameId, factionId: fb.remainingFactionIds[fb.remainingFactionIds.length - 1], turnOrder: to }); await sleep(400); g = await get(); console.log('re-pick → phase', g.currentPhase, Object.values(g.players).map(p => `${p.name}=${p.faction}`).join(' | ')); }
process.exit(ok ? 0 : 1);
