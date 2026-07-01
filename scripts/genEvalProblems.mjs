import fs from 'fs';
const R = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const out = [];
out.push("# AI 평가 문제집 — 100문항");
out.push("");
out.push("각 문항 `→ 답:` 뒤에 A/B/C 또는 `D) 직접수` + 한 줄 이유. 조건부(\"~면 A, ~면 B\")도 OK. 모르겠으면 `답: 스킵`.");
out.push("5개 결정타입(봇 약점) × 20. 저장 후 알려주면 규칙추출+가중치튜닝 돌림.");
out.push("");
let n = 0;
const P = (title, state, opts) => {
  n++;
  out.push(`## Q${n} — ${title}`);
  out.push(`상태: ${state}`);
  opts.forEach(o => out.push(`- ${o}`));
  out.push(`→ 답: ___  이유: ___`);
  out.push("");
};

// 타입1: 우주선 입장 vs 확장
for (let i = 0; i < 20; i++) {
  const rd = R(2, 4), occ = R(0, 3), ship = pick(["Rebellion(nav+1 기술)", "Eclipse(소행성광산)", "Twilight(TS→랩)", "TF Mars(2P삽)"]), qic = R(0, 3), mc = R(2, 6);
  P("우주선 입장 vs 확장",
    `R${rd} | 자원 ${R(3, 9)}C ${R(1, 5)}O ${qic}QIC 파워${R(2, 8)} | 광산${mc} 교역소${R(0, 3)} | ${ship} 탑승자 ${occ}명(입장시 ${occ >= 3 ? "+3파워" : occ >= 1 ? "+2파워" : "파워없음"})`,
    [`A) ${ship} 우주선 입장 (−5VP, 기술/액션)`, `B) 근처 미점유 행성에 광산 확장`, `C) 파워액션(2O/2K 등)으로 자원`]);
}
// 타입2: 연방 형성 타이밍
for (let i = 0; i < 20; i++) {
  const rd = R(2, 6), sat = R(0, 4), feds = R(0, 2), pw = R(3, 9);
  P("연방 형성 타이밍",
    `R${rd} | 지금 형성 시 위성 ${sat}개 필요(7파워) | 파워토큰 ${pw} | 현재 연방 ${feds}개 | 보상 ${pick(["7VP+6C", "초록토큰(고급타일용)", "8VP", "12VP"])}`,
    [`A) 지금 연방 형성 (위성 ${sat})`, `B) 건물 더 짓고 다음 라운드에`, `C) 연구/확장 먼저`]);
}
// 타입3: 고급타일 vs L5 vs 확장
for (let i = 0; i < 20; i++) {
  const rd = R(4, 6), trk = pick(["nav", "terra", "경제", "과학", "gaia"]), green = R(0, 2), tile = pick(["패스마다+VP(강함)", "즉시VP(중간)", "자원형(약함)"]);
  P("고급타일 vs L5 vs 확장",
    `R${rd} | ${trk} L4 도달 | 초록연방 ${green}개 | 고급타일 후보 ${tile} | 아카/연구소 자리 ${pick(["있음", "없음"])}`,
    [`A) 트리거 건물 지어 고급타일 획득`, `B) 광산/새행성 확장`, `C) 초록 써서 ${trk} L5`]);
}
// 타입4: QIC점프 vs nav먼저
for (let i = 0; i < 20; i++) {
  const rd = R(2, 4), nav = R(0, 2), dist = R(2, 4), k = R(0, 8);
  P("QIC점프 vs nav먼저",
    `R${rd} | nav L${nav}(사거리${nav >= 2 ? 2 : 1}) 지식${k} QIC${R(1, 4)} | ${dist}거리 좋은 ${pick(["가이아", "사막(1삽)", "타이타늄"])} 행성 | 1거리에 ${pick(["평범한 빈 행성", "없음"])}`,
    [`A) 지금 QIC 점프해서 ${dist}거리 광산`, `B) nav 연구 먼저(다음턴 사거리↑·QIC절약)`, `C) 가까운 곳에 광산(점프 없이)`]);
}
// 타입5: 포머/확장 우선순위
for (let i = 0; i < 20; i++) {
  const rd = R(2, 5), gf = R(0, 2);
  P("포머/확장 우선순위",
    `R${rd} | 가이아포머 ${gf}개 | 1~2거리 transdim ${pick(["1개", "2개"])} | 사거리내 일반 빈 행성 ${pick(["1개", "없음"])} | 교역소 업글 가능`,
    [`A) transdim에 가이아포머(다음라운드→가이아광산)`, `B) 일반 빈 행성에 광산(즉시)`, `C) 교역소 업글(수입↑)`]);
}

fs.writeFileSync("data/eval-problems-100.md", out.join("\n"));
console.log("생성:", n, "문항 → data/eval-problems-100.md");
