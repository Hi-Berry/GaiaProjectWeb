/** 액션 사용 통계 — 파워 액션 7종 / 우주선 액션 12종 / 기술·특수 액션별 누가 많이 쓰나. */
import path from 'path';
import fs from 'fs';
import { REPO_ROOT, canon, gameRanks, rankTakers, itemCard, pageShell, esc, MIN_GAMES } from '../lib/common.mjs';
import { factionFaceB64 } from '../lib/factions.mjs';

export const meta = {
  id: 'actions',
  order: 9,
  title: '액션 사용 통계',
  emoji: '⚡',
  accent: '#f2a65a',
  description: '파워 액션 · 우주선 액션 · 기술/특수 액션별 사용 횟수·판당 비율 TOP 5',
};

const imgB64 = (rel, mime = 'image/jpeg') => {
  const p = path.join(REPO_ROOT, 'client', 'public', rel);
  return fs.existsSync(p) ? `data:${mime};base64,${fs.readFileSync(p).toString('base64')}` : null;
};

/** 스트립 이미지(가로 N등분 보드)에서 idx칸만 보여주는 원형 크롭 — CSS 클래스는 페이지 style에 정의 */
const stripImg = (cls, cols, idx, label) =>
  `<span class="egg-img strip ${cls}" title="${esc(label)}" style="background-position:${(idx / (cols - 1)) * 100}% 50%"></span>`;
const emojiImg = (e, label) => `<span class="egg-img emoji" title="${esc(label)}">${e}</span>`;

// 파워 액션 7종 — powerAction.jpg 좌→우 순서 (GameLog POWER_ACTION_STRIP과 동일)
const POWER = [
  { re: /^\+3 Knowledge/, idx: 0, label: '7P: 지식 3' },
  { re: /^\+2 Terraform steps/, idx: 1, label: '5P: 테라폼 2스텝' },
  { re: /^\+2 Ore/, idx: 2, label: '4P: 광석 2' },
  { re: /^\+7 Credits/, idx: 3, label: '4P: 크레딧 7' },
  { re: /^\+2 Knowledge/, idx: 4, label: '4P: 지식 2' },
  { re: /^\+1 Terraform step/, idx: 5, label: '3P: 테라폼 1스텝' },
  { re: /^\+2 Power tokens/, idx: 6, label: '3P: 토큰 2' },
];

// 우주선 액션 12종 — Action<Ship>.jpg 3등분 (GameLog SHIP_ACTION_STRIP과 동일)
const SHIPS = [
  { key: 'twilight', name: '트와일라잇', img: 'image/ActionTwilight.jpg', acts: [
    { re: /^Twilight: (Federation benefit|Spaceship Fed)$/, idx: 0, label: '트왈: 3Q 연방 재수령' },
    { re: /^Twilight: TS → Research Lab/, idx: 1, label: '트왈: TS→연구소 (2O 3P)' },
    { re: /^Twilight: \+3 Range/, idx: 2, label: '트왈: 1K 사거리 +3' },
  ] },
  { key: 'rebellion', name: '리벨리온', img: 'image/ActionRebellion.jpg', acts: [
    { re: /^Rebellion: Gain tech tile/, idx: 0, label: '리벨: 3Q 기술 타일' },
    { re: /^Rebellion: Mine → TS/, idx: 1, label: '리벨: 광산→TS (1O 3P)' },
    { re: /^Rebellion: 2K → 1Q 2C/, idx: 2, label: '리벨: 2K→1Q 2C' },
  ] },
  { key: 'tfmars', name: 'TF 마스', img: 'image/ActionTFMars.jpg', acts: [
    { re: /^TF Mars: Tech tiles \+ 2 VP/, idx: 0, label: '마스: 2Q 기술타일×VP' },
    { re: /^TF Mars: Gaia Project/, idx: 1, label: '마스: 2P 가이아 프로젝트' },
    { re: /^TF Mars: 3C → 1 Terraform/, idx: 2, label: '마스: 3C→테라폼 1' },
  ] },
  { key: 'eclipse', name: '이클립스', img: 'image/ActionEclipse.jpg', acts: [
    { re: /^Eclipse: Planet types \+ 2 VP/, idx: 0, label: '이클: 2Q 행성유형×VP' },
    { re: /^Eclipse: 2K\+3P → Research/, idx: 1, label: '이클: 2K+3P 연구 전진' },
    { re: /^Eclipse: 6C → Build mine/, idx: 2, label: '이클: 6C 소행성 광산' },
  ] },
];

// 기술 타일 액션 (Used Tech Action details → 타일 이미지)
const TECH_ACTS = [
  { re: /^Gained 4 Power/, tile: 'TechTile_B9.png', label: '기술타일: 파워 4' },
  { re: /^Gained 3 Knowledge/, tile: 'TechTile_A1.png', label: '고급타일: 지식 3' },
  { re: /^Gained 3 Ore/, tile: 'TechTile_A13.png', label: '고급타일: 광석 3' },
  { re: /^Gained 1 QIC and 5 Credits/, tile: 'TechTile_A8.png', label: '고급타일: 정큐 1 + 크레딧 5' },
];

// 기타 특수 액션 — 실제 이미지: 보너스 액션=보너스 타일(BoostTile_N), 아카데미=건물 이미지, 발타크 4C=종족 초상
// [사용자 2026-09-02] 아카데미 정큐/발타크 4C 분리 + 이모지 대신 게임 이미지
const ETC = [
  { key: 'acad-q', match: (a, d) => a === 'Academy (Right)' && /QIC/.test(d), img: 'image/buildings/titanium_academy.png', mime: 'image/png', pad: true, label: '아카데미: 정큐 획득' },
  { key: 'bon-tf', match: (a, d) => a === 'Bonus Action' && /Terraform Step/i.test(d), img: 'image/BoostTile_1.jpg', rot: true, label: '보너스: 테라폼 스텝' },
  { key: 'bon-gaia', match: (a, d) => a === 'Bonus Action' && /Gaia Project/i.test(d), img: 'image/BoostTile_12.jpg', rot: true, label: '보너스: 가이아 프로젝트' },
  { key: 'bon-range', match: (a, d) => a === 'Bonus Action' && /Range/i.test(d), img: 'image/BoostTile_7.jpg', rot: true, label: '보너스: 사거리 +3' },
];

// 종족 특수 액션 (액션 라벨 접두 → 종족 id, 초상 아이콘)
const FACTION_SPECIALS = [
  { prefix: 'Space Giants: Special', fid: 'space_giants', label: '스자: 테라폼 2스텝' },
  { prefix: 'Gleens: Special', fid: 'gleens', label: '글린: 항해 +2 (다음 액션)' },
  { prefix: 'Ambas: Special', fid: 'ambas', label: '엠바스: PI↔광산 교체' },
  { prefix: 'Tinkeroid: Special', fid: 'tinkeroids', label: '팅커로이드: 라운드 특수' },
  { prefix: 'Moweyip: Special', fid: 'moweyip', label: '모웨이드: 링 놓기' },
  { prefix: 'Firaks: Downgrade', fid: 'firaks', label: '파이락: 연구소 다운그레이드' },
];

export function build({ games, gamesPerPlayer }) {
  // key -> name -> count
  const take = {};
  const add = (key, name) => { (take[key] ??= {})[name] = (take[key][name] ?? 0) + 1; };

  // 종족 특수용 분모: 그 종족을 잡은 판수 (fid -> name -> count)
  // [사용자 2026-09-02] 전체 판수를 분모로 쓰면 그 종족을 가끔 잡는 사람의 비율이 이상하게 낮아짐
  const factionGames = {};
  for (const { game: g } of games) {
    for (const r of gameRanks(g)) {
      if (!r.faction) continue;
      ((factionGames[r.faction] ??= {})[r.name] ??= 0);
      factionGames[r.faction][r.name]++;
    }
  }

  for (const { game: g } of games) {
    for (const l of g.gameLog ?? []) {
      const a = l.action ?? '';
      const d = l.details ?? '';
      const name = l.playerId && g.players[l.playerId] ? canon(g.players[l.playerId].name) : (l.playerName ? canon(l.playerName) : null);
      if (!name) continue;
      if (a === 'Power Action') {
        const p = POWER.find((x) => x.re.test(d));
        if (p) add(`pw${p.idx}`, name);
        continue;
      }
      for (const ship of SHIPS) {
        const act = ship.acts.find((x) => x.re.test(a));
        if (act) { add(`${ship.key}${act.idx}`, name); break; }
      }
      if (a === 'Used Tech Action') {
        const t = TECH_ACTS.find((x) => x.re.test(d));
        if (t) add(`ta${t.tile}`, name);
        continue;
      }
      // 발타크 아카데미 4C — 종족 특수 섹션으로 (분모 = 발타크 잡은 판수)
      if (a === 'Academy (Right)' && !/QIC/.test(d)) { add('fsbaltak4c', name); continue; }
      const etc = ETC.find((x) => x.match(a, d));
      if (etc) { add(`etc${etc.key}`, name); continue; }
      const fsp = FACTION_SPECIALS.find((x) => a.startsWith(x.prefix));
      if (fsp) add(`fs${fsp.fid}`, name);
    }
  }

  const stat = (key) => (take[key] ? rankTakers(take[key], gamesPerPlayer) : null);
  const cardIf = (key, label, imgHtml) => {
    const s = stat(key);
    return s ? itemCard({ label, imgHtml, stat: s, verb: '사용' }) : '';
  };

  const powerCards = POWER.map((p) => cardIf(`pw${p.idx}`, p.label, stripImg('pa', 7, p.idx, p.label))).join('');
  const shipCards = SHIPS.map((ship) => ship.acts.map((act) =>
    cardIf(`${ship.key}${act.idx}`, act.label, stripImg(`sh-${ship.key}`, 3, act.idx, act.label))).join('')).join('');
  const techCards = TECH_ACTS.map((t) => {
    const img = imgB64(`tech/${t.tile}`, 'image/png');
    return cardIf(`ta${t.tile}`, t.label, img ? `<img class="egg-img" src="${img}" alt="${esc(t.label)}" width="58" height="58" />` : emojiImg('🎫', t.label));
  }).join('');
  const etcCards = ETC.map((e) => {
    const src = imgB64(e.img, e.mime ?? 'image/jpeg');
    if (!src) return cardIf(`etc${e.key}`, e.label, emojiImg('⚡', e.label));
    // rot: 세로형 보너스 타일을 90° 눕혀 원형에 꽉 차게 / pad: 건물 이미지는 여백을 줘 축소
    const imgHtml = e.rot
      ? `<span class="egg-img rotwrap" title="${esc(e.label)}"><img src="${src}" alt="" /></span>`
      : `<img class="egg-img" src="${src}" alt="${esc(e.label)}"${e.pad ? ' style="object-fit:contain;padding:7px"' : ''} />`;
    return cardIf(`etc${e.key}`, e.label, imgHtml);
  }).join('');
  const factionCard = (fid, label, byName) => {
    if (!byName) return '';
    // 분모 = 그 종족을 잡은 판수, 최소 3판부터 비율 순위 진입
    const s = rankTakers(byName, factionGames[fid] ?? {}, 3);
    const img = factionFaceB64(fid);
    const imgHtml = img ? `<img class="egg-img" src="${img}" alt="${esc(label)}" />` : emojiImg('👽', label);
    return itemCard({ label, imgHtml, stat: s, verb: '사용' });
  };
  const fsCards = FACTION_SPECIALS.map((f) => factionCard(f.fid, f.label, take[`fs${f.fid}`])).join('')
    + factionCard('bal_tak', '발타크: 아카데미 4C', take['fsbaltak4c']);

  const stripCss = (cls, rel) => {
    const img = imgB64(rel);
    return img ? `.egg-img.${cls} { background-image: url('${img}'); }` : '';
  };

  const body = `
  <style>
    .egg-img.strip { display: inline-block; background-size: auto 100%; background-repeat: no-repeat; }
    .egg-img.emoji { display: inline-flex; align-items: center; justify-content: center; font-size: 27px; }
    /* 세로형 보너스 타일을 90° 눕혀 원형 크롭 (가운데 띠가 보이도록 2배 확대) */
    .egg-img.rotwrap { display: inline-block; position: relative; overflow: hidden; width: 58px; height: 58px; }
    .egg-img.rotwrap img { position: absolute; top: 50%; left: 50%; height: 200%; width: auto; max-width: none;
      transform: translate(-50%, -50%) rotate(-90deg); }
    ${stripCss('pa', 'image/powerAction.jpg')}
    ${SHIPS.map((s) => stripCss(`sh-${s.key}`, s.img)).join('\n')}
  </style>
  <div class="sec"><h2>파워 액션</h2><div class="grid">${powerCards}</div></div>
  <div class="sec"><h2>우주선 액션</h2><div class="grid">${shipCards}</div></div>
  <div class="sec"><h2>기술 타일 액션</h2><div class="grid">${techCards}</div></div>
  <div class="sec"><h2>기타 특수 액션</h2><div class="grid">${etcCards}</div></div>
  <div class="sec"><h2>종족 특수 액션</h2><div class="grid">${fsCards}</div>
    <p class="legend">종족 특수의 판당 비율은 <b>그 종족을 잡은 판수</b>가 분모(그 종족 3판 이상만 순위 진입) —
      예: 팅커로이드 특수 6.0/판 = 잡을 때마다 매 라운드 사용.</p></div>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, accent: meta.accent,
    intro: `전원 사람 <b>4인 게임 ${games.length}판</b>의 게임 로그 기준, 액션별로 누가 많이 쓰는지.
      <b>횟수</b>는 총 사용 수, <b>판당 비율</b>은 자기가 뛴 판수로 나눈 값(${MIN_GAMES}판 이상만 순위 진입).
      단 종족 특수 섹션의 비율은 그 종족을 잡은 판수 기준.`,
    bodyHtml: body,
    footNote: '집계: 게임 로그의 액션 기록 · 우주선 연방 재수령은 트와일라잇 액션만(아티팩트 경유 제외)',
  });
}
