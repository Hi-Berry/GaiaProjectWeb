/**
 * 가치망 학습 — valuenet-data.jsonl({y:최종VP, f:특징})을 읽어 MLP를 학습, valueNet.json 저장.
 * 사용: VALUE_NET_DATA=data/valuenet-data.jsonl npm run train-valuenet
 *   VN_EPOCHS=40 VN_LR=0.02 VN_VAL=0.15 등으로 조정.
 */
import fs from 'fs';
import path from 'path';
import { ValueNet } from './valueNet';
import { FEATURE_DIM } from './features';

const DATA = process.env.VALUE_NET_DATA || path.join(process.cwd(), 'data', 'valuenet-data.jsonl');
const OUT = process.env.VALUE_NET_OUT || path.join(process.cwd(), 'server', 'ai', 'valueNet.json');
const EPOCHS = Number(process.env.VN_EPOCHS) || 40;
const LR = Number(process.env.VN_LR) || 0.02;
const VAL_FRAC = Number(process.env.VN_VAL) || 0.15;

function shuffle<T>(a: T[]) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }

function main() {
    if (!fs.existsSync(DATA)) throw new Error(`데이터 없음: ${DATA} (먼저 VALUE_NET_COLLECT=1 로 self-play 수집)`);
    const lines = fs.readFileSync(DATA, 'utf8').split('\n').filter(l => l.trim());
    const rows: { y: number; f: number[] }[] = [];
    for (const l of lines) {
        try { const r = JSON.parse(l); if (Array.isArray(r.f) && r.f.length === FEATURE_DIM && typeof r.y === 'number') rows.push({ y: r.y, f: r.f }); } catch { }
    }
    if (rows.length < 200) throw new Error(`샘플 부족: ${rows.length} (최소 200+ 권장)`);
    console.log(`[train] samples=${rows.length}, dim=${FEATURE_DIM}, epochs=${EPOCHS}, lr=${LR}`);

    shuffle(rows);
    const nVal = Math.floor(rows.length * VAL_FRAC);
    const val = rows.slice(0, nVal);
    const train = rows.slice(nVal);

    const meanY = train.reduce((s, r) => s + r.y, 0) / train.length;
    const baseMAE = val.reduce((s, r) => s + Math.abs(r.y - meanY), 0) / Math.max(1, val.length);

    const net = new ValueNet(FEATURE_DIM);
    let bestMAE = Infinity; let bestJSON = net.toJSON();

    for (let e = 0; e < EPOCHS; e++) {
        shuffle(train);
        const lr = LR * (1 - e / (EPOCHS * 1.5)); // 선형 감쇠
        let loss = 0;
        for (const r of train) loss += net.trainStep(r.f, r.y, lr);
        // validation MAE (VP 단위)
        let mae = 0; for (const r of val) mae += Math.abs(net.predict(r.f) - r.y);
        mae /= Math.max(1, val.length);
        if (mae < bestMAE) { bestMAE = mae; bestJSON = net.toJSON(); }
        if (e % 5 === 0 || e === EPOCHS - 1) console.log(`  epoch ${e}: trainMSE(scaled)=${(loss / train.length).toFixed(4)}  valMAE=${mae.toFixed(2)} VP`);
    }

    console.log(`[train] baseline MAE(predict mean=${meanY.toFixed(1)}): ${baseMAE.toFixed(2)} VP`);
    console.log(`[train] best val MAE: ${bestMAE.toFixed(2)} VP  (개선 ${(baseMAE - bestMAE).toFixed(2)} VP)`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(bestJSON));
    console.log(`[train] saved -> ${OUT}`);
}

main();
