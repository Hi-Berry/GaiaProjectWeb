// 사람 게임 로그(data/human-games/*.json) 한 판을 사람이 읽는 상세 로그(마크다운)로 렌더링.
// 사용:  node scripts/gameDetailLog.mjs 2026-09-09_2mxhog2b            (파일명 앞부분 또는 gameId)
//        node scripts/gameDetailLog.mjs --faction=hadsch_hallas         (해당 종족이 있는 사람 4인 게임 중 무작위 1판)
//        node scripts/gameDetailLog.mjs <게임> --out=경로.md
// 출력: data/game-detail/<파일명>.md
//
// 내용: 참가자·순위·플레이 시간 → 라운드별 전 액션(시각, 행동자, 행동, 상세, 자원 변화, 파워 리치 등 부속 로그)
//       → 라운드 끝 점수판 → 최종 점수 세부(scoreBreakdown). 종족명은 stats-site FACTION_KO 공식 한글 표기.
import fs from 'fs';
import path from 'path';
import { canon, isBot, DATA_DIR, REPO_ROOT } from '../stats-site/lib/common.mjs';
import { FACTION_KO } from '../stats-site/lib/factions.mjs';

const args = process.argv.slice(2);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=').slice(1).join('=') || null;
const target = args.find((a) => !a.startsWith('--'));
const BREAK = 10 * 60 * 1000;

const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
let file;
if (target) {
  file = files.find((f) => f.startsWith(target) || f.includes(`_${target}.json`) || f === target);
  if (!file) { console.error(`게임을 찾을 수 없음: ${target}`); process.exit(1); }
} else if (opt('faction')) {
  const fac = opt('faction');
  const cands = files.filter((f) => {
    const g = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    const ids = Object.keys(g.players ?? {});
    return ids.length === 4 && !ids.some((id) => isBot(g, id)) && g.roundNumber >= 6 && ids.some((id) => g.players[id].faction === fac);
  });
  if (!cands.length) { console.error(`종족 ${fac} 게임 없음`); process.exit(1); }
  file = cands[Math.floor(Math.random() * cands.length)];
} else {
  console.error('사용법: node scripts/gameDetailLog.mjs <게임파일|gameId> | --faction=<종족id>');
  process.exit(1);
}

const g = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
const P = g.players;
const ids = Object.keys(P);
const nameOf = (pid) => (pid && P[pid] ? canon(P[pid].name) : '');
const facOf = (pid) => (pid && P[pid] ? FACTION_KO[P[pid].faction] ?? P[pid].faction : '');
const who = (pid) => (pid && P[pid] ? `**${nameOf(pid)}**(${facOf(pid)})` : '_시스템_');

const ACTION_KO = {
  'Selected Faction': '종족 선택', 'Placed Starting Mine': '시작 광산 배치', 'Placed Starting Planetary Institute': '시작 행성연구소 배치',
  'Selected Bonus Tile': '보너스 타일 선택', 'Selected Bonus': '패스 · 보너스 타일 선택', 'Round Start': '라운드 시작', 'Income Order': '수입',
  'Built Mine': '광산 건설', 'Built Mine on Asteroid': '소행성 광산 건설', 'Built Mine on Proto': '원시행성 광산 건설',
  'Upgraded to Trading Station': '교역소 승급', 'Upgraded to Research Lab': '연구소 승급', 'Upgraded to Academy': '아카데미 승급',
  'Upgraded to Planetary Institute': '행성연구소 승급', 'Academy (Right)': '아카데미(우) 특수 액션', 'Advanced Research': '연구 진행',
  'Gained Tech Tile': '기술 타일 획득', 'Advanced Tech Tile': '고급 기술 타일 획득', 'Power Action': '파워 액션', 'Free Actions': '자유 행동(자원 변환)',
  'Undo Free Action': '자유 행동 취소', 'Used Tech Action': '기술 타일 액션', 'Bonus Action': '보너스 타일 액션', 'Federation': '연방 결성',
  'Federation Reward': '연방 보상', 'Placed Gaiaformer': '가이아포머 배치', 'Entered Ship': '우주선 입장', 'Final Mission': '최종 임무 채점',
  'Game Finished': '게임 종료', 'Power Burn': '파워 소각', 'Geodens Council': '기오덴 의회', 'Lost Planet (Nav 5)': '잃어버린 행성(항법 5)',
  'Terra Reward': '테라포밍 트랙 보상', 'Economy Track Reward': '경제 트랙 보상',
};
const RES = [['vp', 'VP'], ['c', 'C'], ['o', 'O'], ['k', 'K'], ['q', 'Q'], ['p1', 'P1'], ['p2', 'P2'], ['p3', 'P3'], ['bs', 'BS']];
const diff = (a, b) => {
  if (!a || !b) return '';
  const parts = [];
  for (const [k, lab] of RES) {
    if (a[k] === undefined && b[k] === undefined) continue;
    const x = a[k] ?? 0, y = b[k] ?? 0;
    if (x !== y) parts.push(`${lab} ${x}→${y}`);
  }
  return parts.join(', ');
};
const snapStr = (s) => s ? RES.filter(([k]) => s[k] !== undefined && k !== 'vp').map(([k, lab]) => `${lab}${s[k]}`).join(' ') : '';
const hm = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

const log = [...(g.gameLog ?? [])].sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || (a.timestamp ?? 0) - (b.timestamp ?? 0));
const ts = log.map((e) => e.timestamp).filter(Boolean).sort((a, b) => a - b);
let play = 0, breaks = 0;
for (let i = 1; i < ts.length; i++) { const gap = ts[i] - ts[i - 1]; if (gap >= BREAK) breaks++; else play += gap; }

// 순위
const ranked = ids.map((id) => ({ id, score: P[id].score ?? 0 })).sort((a, b) => b.score - a.score);
const rankOf = (id) => 1 + ranked.filter((r) => r.score > (P[id].score ?? 0)).length;
const order = g.turnOrder?.length ? g.turnOrder : ids;

const date = file.slice(0, 10);
const out = [];
out.push(`# 게임 상세 로그 — ${date}`);
out.push('');
out.push(`- 시작 ${ts.length ? hm(ts[0]) : '?'} · 종료 ${ts.length ? hm(ts.at(-1)) : '?'} · 실플레이 ${Math.round(play / 60000)}분${breaks ? ` (10분 이상 휴식 ${breaks}회 제외)` : ''} · 라운드 ${g.roundNumber} · 로그 ${log.length}건`);
out.push('');
out.push('| 순위 | 이름 | 종족 | 최종 점수 | 시작 순서 | 마지막 보너스 타일 | 기술 타일 | 연방 |');
out.push('|---|---|---|---|---|---|---|---|');
for (const { id } of ranked) {
  const p = P[id];
  out.push(`| ${rankOf(id)} | ${nameOf(id)} | ${facOf(id)} | ${p.score} | ${order.indexOf(id) + 1} | ${p.bonusTile ?? ''} | ${(p.techTiles ?? []).length} | ${(p.federations ?? []).length} |`);
}
out.push('');

// 라운드별
let curRound = null;
const lastVp = {}; // 라운드 끝 점수판용
for (const e of log) {
  const r = e.round ?? 0;
  if (r !== curRound) {
    if (curRound !== null) out.push(...roundBoard(curRound));
    curRound = r;
    out.push('', `## ${r === 0 ? '준비 단계 (종족 선택 · 시작 광산 · 보너스 타일)' : `라운드 ${r}`}`, '');
  }
  if (e.snap && e.playerId) lastVp[e.playerId] = e.snap;
  const act = ACTION_KO[e.action] ?? e.action;
  const det = [e.details, e.tileId ? `\`${e.tileId}\`` : ''].filter(Boolean).join(' · ');
  const d = diff(e.base, e.snap);
  let line = `- ${e.seq ?? ''}. [${hm(e.timestamp)}] ${who(e.playerId)} **${act}**${det ? ` — ${det}` : ''}`;
  if (d) line += `  \n  ↳ ${d}`;
  if (e.fedHexes?.length) line += `  \n  ↳ 연방 편입 칸 ${e.fedHexes.length}개: ${e.fedHexes.join(', ')}`;
  if (e.passInfo) line += `  \n  ↳ 패스: ${typeof e.passInfo === 'string' ? e.passInfo : JSON.stringify(e.passInfo)}`;
  out.push(line);
  for (const s of e.subLogs ?? []) out.push(`  - ${s.text}${s.playerName && !s.text.includes(s.playerName) ? ` (${canon(s.playerName)})` : ''}`);
}
if (curRound !== null) out.push(...roundBoard(curRound));

function roundBoard(r) {
  const rows = ids.map((id) => `| ${nameOf(id)} | ${facOf(id)} | ${lastVp[id]?.vp ?? ''} | ${snapStr(lastVp[id])} |`);
  return ['', `**라운드 ${r} 종료 시점**`, '', '| 이름 | 종족 | VP | 자원 |', '|---|---|---|---|', ...rows];
}

// 최종 점수 세부
out.push('', '## 최종 점수 세부', '');
for (const { id } of ranked) {
  const p = P[id]; const b = p.scoreBreakdown ?? {};
  out.push(`### ${rankOf(id)}위 ${nameOf(id)} (${facOf(id)}) — ${p.score}점`, '');
  const GROUP_KO = { other: '기타(연방·우주선·비딩 등)', techTiles: '기술 타일', spaceships: '우주선', bonusTilePass: '패스 보너스 타일', roundMissions: '라운드 임무', finalMissions: '최종 임무', finalMissionDetails: '최종 임무 세부', powerReceived: '파워 리치로 잃은 VP', researchTracks: '연구 트랙', remainingResources: '잔여 자원' };
  const label = (x) => x.source ?? x.tileId ?? x.shipType ?? x.missionId ?? (x.round != null ? `R${x.round}` : '') ?? '';
  const entries = Object.entries(b).filter(([k, v]) => ((Array.isArray(v) && v.length) || typeof v === 'number') && !(k === 'finalMissions' && b.finalMissionDetails?.length));
  if (!entries.length) { out.push('_세부 내역 없음_', ''); continue; }
  out.push('| 항목 | 내역 | VP |', '|---|---|---|');
  for (const [k, v] of entries) {
    if (typeof v === 'number') { out.push(`| ${GROUP_KO[k] ?? k} |  | **${k === 'powerReceived' && v > 0 ? -v : v}** |`); continue; }
    const sum = v.reduce((s, x) => s + (x.vp ?? 0), 0);
    const items = v.map((x) => `${label(x)}${x.round != null && x.tileId ? ` R${x.round}` : ''}(${x.vp > 0 ? '+' : ''}${x.vp ?? 0})`).join(', ');
    out.push(`| ${GROUP_KO[k] ?? k} | ${items} | **${sum}** |`);
  }
  out.push(`| 연구 | ${Object.entries(p.research ?? {}).map(([t, l]) => `${t} ${l}`).join(', ')} | |`);
  out.push('');
}

const outPath = opt('out') ?? path.join(REPO_ROOT, 'data', 'game-detail', file.replace(/\.json$/, '.md'));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out.join('\n'), 'utf8');
console.log(`✔ ${file} → ${path.relative(REPO_ROOT, outPath)} (${out.length}줄)`);
console.log(ranked.map(({ id }) => `${rankOf(id)}위 ${nameOf(id)} ${facOf(id)} ${P[id].score}`).join(' · '));
