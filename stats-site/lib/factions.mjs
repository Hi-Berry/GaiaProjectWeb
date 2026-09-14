/** 종족 id → 한국어 표기 + 초상 썸네일 (client/public/race/race_face_*.png) */
import path from 'path';
import fs from 'fs';
import { REPO_ROOT } from './common.mjs';

export const FACTION_KO = {
  terran: '테란', lantids: '란티다', hadsch_hallas: '하드쉬', ivits: '하이브',
  geodens: '기오덴', bal_tak: '발타크', xenos: '제노스', gleens: '글린',
  taklons: '타클론', ambas: '엠바스', bescods: '메안', firaks: '파이락',
  itars: '아이타', nevlas: '네뷸라', moweyip: '모웨이드', space_giants: '스페이스 자이언트',
  tinkeroids: '팅커로이드', darkanians: '다카니안',
};
/** 종족 대표색 — shared/gameConfig PLANET_COLORS(홈 행성색)를 어두운 배경에서 보이게 밝힌 표시용 */
export const FACTION_COLOR = {
  terran: '#5b7fd1', lantids: '#5b7fd1', hadsch_hallas: '#e04a4a', ivits: '#e04a4a',
  geodens: '#ff7a33', bal_tak: '#ff7a33', xenos: '#f9c74f', gleens: '#f9c74f',
  taklons: '#a0704f', ambas: '#a0704f', bescods: '#9aa3ad', firaks: '#9aa3ad',
  itars: '#b3e5fc', nevlas: '#b3e5fc', moweyip: '#00e5ff', space_giants: '#00e5ff',
  tinkeroids: '#c76fd6', darkanians: '#c76fd6',
};
export const factionKo = (id) => FACTION_KO[id] ?? id ?? '?';

const RACE_IMAGE_SLUG = {
  terran: 'Terrans', lantids: 'Lantids', hadsch_hallas: 'HadschHallas', ivits: 'Ivits',
  geodens: 'Geodens', bal_tak: 'BalTaks', xenos: 'Xenos', gleens: 'Gleens',
  taklons: 'Taklons', ambas: 'Ambas', bescods: 'Bescods', firaks: 'Firaks',
  itars: 'Itars', nevlas: 'Nevlas', moweyip: 'Moweyds', space_giants: 'SpaceGiants',
  tinkeroids: 'Tinkeroids', darkanians: 'Darkanians',
};

/** 종족 얼굴 썸네일 data URI (없으면 null) */
export function factionFaceB64(id) {
  const slug = RACE_IMAGE_SLUG[id];
  if (!slug) return null;
  const p = path.join(REPO_ROOT, 'client', 'public', 'race', `race_face_${slug}.png`);
  if (!fs.existsSync(p)) return null;
  return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
}
