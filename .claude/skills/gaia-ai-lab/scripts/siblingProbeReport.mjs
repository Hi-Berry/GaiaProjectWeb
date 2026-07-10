/**
 * Reads data/sibling-probe.jsonl and computes ranking-agreement metrics between the trained
 * value net and the hand-written heuristic over sibling candidate sets.
 */
import fs from 'fs';
import path from 'path';

const IN = process.env.SIBLING_PROBE_OUT || path.join(process.cwd(), 'data', 'sibling-probe.jsonl');

function argmax(a) { let bi = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[bi]) bi = i; return bi; }
function topKIndices(a, k) {
    return a.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]).slice(0, k).map(p => p[1]);
}
// average ranks (1..n), higher value => higher rank number is arbitrary; we just need consistent ranks for both
function ranks(a) {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(a.length);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        const avg = (i + j) / 2 + 1; // average rank (1-based)
        for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
        i = j + 1;
    }
    return r;
}
function pearson(x, y) {
    const n = x.length;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    if (sxx === 0 || syy === 0) return null; // undefined (all equal)
    return sxy / Math.sqrt(sxx * syy);
}
function spearman(a, b) { return pearson(ranks(a), ranks(b)); }
function kendall(a, b) {
    const n = a.length;
    let conc = 0, disc = 0, valid = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const da = a[i] - a[j], db = b[i] - b[j];
        if (da === 0 || db === 0) continue; // skip ties (tau-a on untied pairs)
        valid++;
        if (Math.sign(da) === Math.sign(db)) conc++; else disc++;
    }
    if (valid === 0) return null;
    return (conc - disc) / valid;
}

const lines = fs.existsSync(IN) ? fs.readFileSync(IN, 'utf8').split('\n').filter(Boolean) : [];
if (lines.length === 0) { console.error(`No records at ${IN}`); process.exit(1); }

let total = 0, top1 = 0, top3 = 0;
let spSum = 0, spN = 0, ktSum = 0, ktN = 0;
const candDist = {};
let tiedArgmaxHeur = 0, tiedArgmaxNet = 0;
// tie-tolerant top-1: net argmax value is among heuristic's max-value set
let top1Tol = 0;

for (const ln of lines) {
    let rec; try { rec = JSON.parse(ln); } catch { continue; }
    const h = rec.heur, v = rec.net;
    if (!Array.isArray(h) || !Array.isArray(v) || h.length < 2 || h.length !== v.length) continue;
    total++;
    candDist[h.length] = (candDist[h.length] || 0) + 1;

    const hArg = argmax(h), vArg = argmax(v);
    if (hArg === vArg) top1++;

    // tie-tolerant: does net's picked candidate achieve (near) the heuristic max?
    const hMax = Math.max(...h);
    const hMaxSet = new Set(h.map((x, i) => (x === hMax ? i : -1)).filter(i => i >= 0));
    if (hMaxSet.size > 1) tiedArgmaxHeur++;
    const vMax = Math.max(...v);
    if (v.filter(x => x === vMax).length > 1) tiedArgmaxNet++;
    if (hMaxSet.has(vArg)) top1Tol++;

    const t3 = new Set(topKIndices(h, 3));
    if (t3.has(vArg)) top3++;

    const sp = spearman(h, v);
    if (sp !== null && Number.isFinite(sp)) { spSum += sp; spN++; }
    const kt = kendall(h, v);
    if (kt !== null && Number.isFinite(kt)) { ktSum += kt; ktN++; }
}

const pct = (x) => (100 * x / total).toFixed(1) + '%';
const top1Rate = top1 / total;

console.log('================ SIBLING-RANKING PROBE REPORT ================');
console.log(`records file            : ${IN}`);
console.log(`decisions counted (>=2) : ${total}`);
console.log('');
console.log(`TOP-1 agreement          : ${pct(top1)}   (argmax net == argmax heuristic)   [DECISIVE]`);
console.log(`TOP-1 agreement (tie-tol): ${pct(top1Tol)}  (net pick reaches heuristic max value)`);
console.log(`TOP-1 in heuristic top-3 : ${pct(top3)}`);
console.log(`Mean Spearman rho        : ${spN ? (spSum / spN).toFixed(3) : 'n/a'}  (n=${spN})`);
console.log(`Mean Kendall tau         : ${ktN ? (ktSum / ktN).toFixed(3) : 'n/a'}  (n=${ktN})`);
console.log('');
console.log(`decisions w/ tied heuristic argmax: ${tiedArgmaxHeur} (${pct(tiedArgmaxHeur)})`);
console.log(`decisions w/ tied net argmax      : ${tiedArgmaxNet} (${pct(tiedArgmaxNet)})`);
console.log('');
console.log('candidate-count distribution:');
for (const k of Object.keys(candDist).map(Number).sort((a, b) => a - b)) {
    console.log(`   ${String(k).padStart(3)} cands : ${candDist[k]}`);
}
console.log('');
let verdict;
if (top1Rate >= 0.85) verdict = 'GO — net ranks siblings as well as heuristic (>=85%). The -14 was likely a scale/UCT bug; a normalize+retune fix is viable.';
else if (top1Rate < 0.65) verdict = 'NO-GO for a cheap fix — net fundamentally too coarse (<65%). Needs feature+data overhaul.';
else verdict = 'AMBIGUOUS (65-85%) — lean on Spearman/top-3; a cheap fix is uncertain.';
console.log(`VERDICT: ${verdict}`);
console.log('=============================================================');
