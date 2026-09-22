// 테라포밍 원(7색 행성) 그림 '요청문' 생성기 — 사용: node scripts/genTerraformWheelPrompt.mjs [--from oxide] [--lang en|ko|both]
//
// 왜 스크립트인가: 그림 생성 사이트(또는 그리는 사람)에 붙여넣을 문구를 매번 손으로 쓰면 행성 순서·색·종족이
//   코드와 어긋난다. 원 순서·색·홈 종족을 shared/gameConfig 에서 그대로 읽어 요청문을 뽑는다.
//   이미지 API는 호출하지 않는다(출력은 붙여넣기용 텍스트). genBadgeImagePrompt.mjs 와 같은 방식.
//
// 규칙(코드 기준): HOME_PLANETS 순서로 원을 돌며 인접 = 1삽, 두 칸 = 2삽, 반대편(세 칸) = 3삽.
import { HOME_PLANETS, PLANET_COLORS, FACTIONS } from '../shared/gameConfig.ts';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const focus = opt('--from', null);
const lang = opt('--lang', 'both');
if (focus && !HOME_PLANETS.includes(focus)) { console.error(`--from 은 ${HOME_PLANETS.join('|')} 중 하나`); process.exit(1); }

const KO = { terra: '테라(파랑)', volcanic: '화산(빨강)', oxide: '산화(주황)', desert: '사막(노랑)', swamp: '습지(갈색)', titanium: '티타늄(회색)', ice: '얼음(하늘색)' };
const EN = { terra: 'Terra (blue)', volcanic: 'Volcanic (red)', oxide: 'Oxide (orange)', desert: 'Desert (yellow)', swamp: 'Swamp (brown)', titanium: 'Titanium (grey)', ice: 'Ice (light blue)' };
const FACTION_KO = { terran: '테란', lantids: '란티다', hadsch_hallas: '하드시 할라', ivits: '이비츠', geodens: '기오덴', bal_tak: '발타크', xenos: '제노스', gleens: '글린', taklons: '타클론', ambas: '엠바스', bescods: '베스코즈', firaks: '피락스', itars: '아이타', nevlas: '네블라스' };
const homeFactions = (p) => FACTIONS.filter(f => f.homePlanet === p).map(f => f.id);
const steps = (a, b) => { const d = Math.abs(HOME_PLANETS.indexOf(a) - HOME_PLANETS.indexOf(b)); return Math.min(d, 7 - d); };

const ringEn = HOME_PLANETS.map((p, i) => `${i + 1}. ${EN[p]} ${PLANET_COLORS[p]} — home of ${homeFactions(p).map(id => FACTIONS.find(f => f.id === id).name).join(' & ')}`).join('\n');
const ringKo = HOME_PLANETS.map((p, i) => `${i + 1}. ${KO[p]} ${PLANET_COLORS[p]} — ${homeFactions(p).map(id => FACTION_KO[id] ?? id).join('·')}`).join('\n');

let focusEn = '', focusKo = '';
if (focus) {
  const two = HOME_PLANETS.filter(q => steps(focus, q) === 2), three = HOME_PLANETS.filter(q => steps(focus, q) === 3);
  focusEn = `\nHighlight ${EN[focus]} with a glowing gold ring. Draw thin orange curved lines from it to ${two.map(q => EN[q]).join(' and ')} labeled "2", and a red dotted line to ${three.map(q => EN[q]).join(' and ')} labeled "3".`;
  focusKo = `\n${KO[focus]}를 금색 테두리로 강조하고, 거기서 ${two.map(q => KO[q]).join('·')}까지 주황 곡선에 "2", ${three.map(q => KO[q]).join('·')}까지 빨간 점선에 "3"을 표시.`;
}

const promptEn = `Educational infographic for the board game Gaia Project: the terraforming wheel.
Seven planets arranged evenly on a circle, clockwise starting from the top, in exactly this order with these colors:
${ringEn}
Each planet is a clean flat circle in its color with a thin white outline and its name inside. Neighboring planets on the circle are connected by short light-blue lines labeled "1" (one terraforming step). A faint dashed circle passes through all seven planets.${focusEn}
Below the wheel, a caption: "adjacent = 1 step, two apart = 2 steps, opposite = 3 steps". Dark space background (#0D1117), minimal sci-fi board-game style, high contrast, crisp vector look, no extra planets, no text other than the labels, centered composition, square 1:1.`;

const negativeEn = `blurry, photorealistic, extra planets, wrong order, overlapping labels, gradients on planets, rings around planets, spaceships, people, watermark, cropped`;

const promptKo = `보드게임 '가이아 프로젝트' 테라포밍 원을 설명하는 인포그래픽.
행성 7개를 원 위에 같은 간격으로, 12시부터 시계방향으로 정확히 이 순서와 색으로 배치:
${ringKo}
각 행성은 그 색의 납작한 원(흰 테두리, 안에 이름). 원에서 이웃한 행성끼리만 짧은 하늘색 선으로 잇고 선마다 "1"(1삽) 표기. 일곱 행성을 지나는 흐린 점선 원.${focusKo}
원 아래 캡션: "인접 = 1삽, 두 칸 = 2삽, 반대편 = 3삽". 어두운 우주 배경(#0D1117), 단순한 SF 보드게임 스타일, 고대비, 또렷한 벡터 느낌, 다른 행성·인물·우주선 없음, 라벨 외 글자 없음, 정사각형 1:1.`;

const out = [];
if (lang === 'en' || lang === 'both') out.push('=== PROMPT (EN) ===\n' + promptEn, '=== NEGATIVE PROMPT ===\n' + negativeEn);
if (lang === 'ko' || lang === 'both') out.push('=== 요청문 (KO) ===\n' + promptKo);
out.push('=== 체크리스트(생성 결과 검수) ===\n' + [
  `순서: ${HOME_PLANETS.map(p => KO[p].split('(')[0]).join(' → ')} → (테라)`,
  '인접선 7개에 전부 "1" — 건너뛰는 선은 없어야 함' + (focus ? `, 기준 행성에서만 2·3 선` : ''),
  '가이아(초록)·트랜스딤(보라)·원시·소행성이 끼어들면 잘못된 그림',
].map(s => '- ' + s).join('\n'));
console.log(out.join('\n\n'));
