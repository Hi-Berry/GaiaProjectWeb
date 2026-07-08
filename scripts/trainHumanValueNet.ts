/**
 * Path 2 트레이너 — 강한 "사람" 결정만으로 가치망 학습 (self-play 봇 데이터 배제).
 *
 * 배경: data/valuenet-data.jsonl 은 dev플레이+head2head가 다 쌓여 190만 줄(>512MB) 중 99%가 봇(self-play).
 * 봇 데이터로 학습한 망은 그리디 휴리스틱과 동급(중립, 메모리 value-net-blend-neutral). path 2의 핵심은
 * **강한 사람(1:3에서 200+점)의 결정에서 "엔진 구성 → 최종VP" 비선형 관계를 학습**해 MCTS 리프평가에 주입,
 * 봇이 가이아/연방/기술타일 같은 다턴 복리투자를 스스로 가치있게 보게 만드는 것.
 *
 * - 스트리밍 파싱(OOM 회피), bot:false 만 사용.
 * - score 계열 피처 마스킹 → 망이 "현재점수 읽기" 지름길 대신 엔진 구성으로 예측하게 강제(휴리스틱 초과분 학습).
 * - 끝에 probe: 기술타일/가이아/연방/연구를 올리면 예측VP가 오르는지 = path 2 viability 신호.
 *
 * 실행: npx tsx scripts/trainHumanValueNet.ts
 * 환경: EP(에폭, 기본40) MINVP(이 점수 미만 사람 샘플 제외, 기본0) OUT(저장경로)
 */
import fs from 'fs';
import readline from 'readline';
import { ValueNet } from '../server/ai/valueNet';
import { FEATURE_DIM, FEATURE_NAMES } from '../server/ai/features';

const DATA = process.env.VALUE_NET_DATA || 'data/human-features.jsonl';
// [배선수정 2026-07-08] 이 트레이너는 features.ts 33피처 ValueNet(시스템②)을 학습한다 → getValueNet가 읽는
//   valueNet.json에 써야 한다. 기존 기본값 humanValueNet.json은 evaluator.computeHumanValueVP(시스템①,
//   인라인 22피처, valueProbe.mjs가 학습)이 읽는 파일이라, 여기 쓰면 22피처 consumer가 33피처 모델을 읽어
//   predVP 쓰레기→봇 붕괴(2026-07-07 무효사고). 두 시스템 분리: ①humanValueNet.json=22피처(valueProbe),
//   ②valueNet.json=33피처 MLP(trainValueNet/trainHumanValueNet).
const OUT = process.env.OUT || 'server/ai/valueNet.json';
const EPOCHS = Number(process.env.EP) || 40;
const MINVP = Number(process.env.MINVP) || 0; // 약한 사람게임 거르려면 올림(예: 100)
const LR = 0.02;
// score 계열 피처 인덱스 마스킹(현재점수=2, scoreVsMaxOpp=29, scoreVsMeanOpp=30)
const MASK = [2, 29, 30];

function mask(f: number[]): number[] { const g = f.slice(); for (const i of MASK) g[i] = 0; return g; }
function shuffle<T>(a: T[]) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }

async function loadHuman(): Promise<{ y: number; f: number[]; g: string }[]> {
    const rows: { y: number; f: number[]; g: string }[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(DATA), crlfDelay: Infinity });
    let total = 0, bot = 0;
    for await (const line of rl) {
        if (!line.trim()) continue;
        total++;
        let r: any; try { r = JSON.parse(line); } catch { continue; }
        if (r.bot) { bot++; continue; }            // 사람만
        if (!Array.isArray(r.f) || r.f.length !== FEATURE_DIM || typeof r.y !== 'number') continue;
        if (r.y < MINVP) continue;
        rows.push({ y: r.y, f: mask(r.f), g: r.g ?? 'unknown' });
    }
    console.log(`스트림: 총 ${total} | 봇 ${bot} 제외 | 사람 사용 ${rows.length} (MINVP=${MINVP})`);
    return rows;
}

(async () => {
    const rows = await loadHuman();
    if (rows.length < 200) { console.error('사람 샘플이 너무 적음 — 1:3 게임 더 필요(>~50판 권장).'); process.exit(1); }

    // 게임단위 train/val 분할 (누출 방지: 같은 게임 샘플은 한쪽에만).
    const gameIds = [...new Set(rows.map(r => r.g))];
    shuffle(gameIds);
    const nValGames = Math.max(1, Math.floor(gameIds.length * 0.2));
    const valGames = new Set(gameIds.slice(0, nValGames));
    const val = rows.filter(r => valGames.has(r.g));
    const train = rows.filter(r => !valGames.has(r.g));
    console.log(`게임 ${gameIds.length}개 → train게임 ${gameIds.length - nValGames} / val게임 ${nValGames} | train샘플 ${train.length} val샘플 ${val.length} (게임단위, 누출없음)`);

    // 평균 기준선(상수 예측) MAE — 망이 이걸 이겨야 의미.
    const meanY = train.reduce((s, r) => s + r.y, 0) / train.length;
    const baseMAE = val.reduce((s, r) => s + Math.abs(r.y - meanY), 0) / val.length;

    const net = new ValueNet(FEATURE_DIM);
    for (let e = 0; e < EPOCHS; e++) {
        shuffle(train);
        const lr = LR * (1 - e / (EPOCHS * 1.5));
        for (const r of train) net.trainStep(r.f, r.y, lr);
        if (e % 8 === 0 || e === EPOCHS - 1) {
            let mae = 0; for (const r of val) mae += Math.abs(net.predict(r.f) - r.y); mae /= val.length;
            console.log(`  epoch ${e}: valMAE=${mae.toFixed(1)} (상수기준 ${baseMAE.toFixed(1)})`);
        }
    }
    fs.writeFileSync(OUT, JSON.stringify(net.toJSON()));
    console.log(`\n저장: ${OUT}`);

    // === path 2 viability probe: 엔진 피처를 올리면 예측VP가 오르나? (score 마스킹 상태) ===
    // 평균적 중반 보드를 기준으로, 각 엔진축을 사람 상위수준으로 올렸을 때 ΔVP.
    const base = new Array(FEATURE_DIM).fill(0);
    base[0] = 0.5; base[1] = 3 / 6;                 // round3, 남은3
    base[11] = 4 / 8; base[12] = 1.5 / 4; base[13] = 1 / 3; // 광산4 TP1.5 lab1
    base[16] = 1 / 5; base[17] = 3 / 5;             // tf1, nav3 (봇 현실)
    base[26] = 7 / 14;                              // 구조총합7
    const bp = net.predict(base);
    console.log(`\n[viability probe] 기준(봇형 중반) 예측VP: ${bp.toFixed(1)}`);
    const probes: [string, number, number][] = [
        ['가이아연구 0→4', 19, 4 / 5],
        ['테라포밍연구 1→4', 16, 4 / 5],
        ['기술타일 2→8', 23, 8 / 6],
        ['연방 1→4', 22, 4 / 3],
        ['가이아행성 0→5', 28, 5 / 6],
        ['행성종류 2→6', 27, 6 / 8],
        ['광산 4→8', 11, 8 / 8],
    ];
    let good = 0;
    for (const [label, idx, v] of probes) {
        const x = base.slice(); x[idx] = v; const p = net.predict(x);
        const d = p - bp; if (d > 0.5) good++;
        console.log(`  ${label.padEnd(16)} (${FEATURE_NAMES[idx]}): ${d >= 0 ? '+' : ''}${d.toFixed(1)} VP`);
    }
    console.log(`\n→ 엔진축 ${good}/${probes.length}개가 양(+)의 gradient. 4개 이상이면 다턴 엔진가치를 학습한 것(useValueNet 주입 가치 有). 검증은 너의 1:3.`);
})();
