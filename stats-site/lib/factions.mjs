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
