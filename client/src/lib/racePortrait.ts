/** `public/race/race_*.png` 파일명과 게임 내 faction id 매핑 */
const RACE_IMAGE_SLUG: Record<string, string> = {
  terran: 'Terrans',
  lantids: 'Lantids',
  hadsch_hallas: 'HadschHallas',
  ivits: 'Ivits',
  geodens: 'Geodens',
  bal_tak: 'BalTaks',
  xenos: 'Xenos',
  gleens: 'Gleens',
  taklons: 'Taklons',
  ambas: 'Ambas',
  bescods: 'Bescods',
  firaks: 'Firaks',
  itars: 'Itars',
  nevlas: 'Nevlas',
  moweyip: 'Moweyds',
  space_giants: 'SpaceGiants',
  tinkeroids: 'Tinkeroids',
  darkanians: 'Darkanians',
};

/** 종족 초상화 URL. 없으면 null (폴백 UI 사용) */
export function racePortraitSrc(factionId: string): string | null {
  const slug = RACE_IMAGE_SLUG[factionId];
  return slug ? `/race/race_${slug}.png` : null;
}
