#!/usr/bin/env python3
"""[ai2 1단계 2026-10-05] 정책·가치망 학습 — script/ai2GenData.ts가 만든 JSONL.gz(희소 인코딩)로.

모델:
  상태 = CNN(격자 51×20×24) ⊕ MLP(평탄 1,091) → 상태 임베딩
  정책 = 후보마다 MLP(수 특징 203 ⊕ 그 칸의 CNN 특징맵) ⊕ 상태 임베딩 → 로짓, 후보 집합 softmax(CE)
  가치 = 상태 임베딩 → (내 최종 점수 − 상대 평균)/50   (MSE)
검증: 게임 단위 홀드아웃 20%. 정책 top-1/top-3(봇 라벨 기준), 가치 MAE·상관·부호 일치.

  python3 scripts/ai2/train_ai2.py --data data/ai2/selfplay --epochs 8 --out data/ai2/model_v0.pt
"""
import argparse, glob, gzip, json, os, random, time
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F

ap = argparse.ArgumentParser()
ap.add_argument('--data', default='data/ai2/selfplay'); ap.add_argument('--epochs', type=int, default=8)
ap.add_argument('--batch', type=int, default=64); ap.add_argument('--lr', type=float, default=1e-3)
ap.add_argument('--maxk', type=int, default=96); ap.add_argument('--seed', type=int, default=0)
ap.add_argument('--vw', type=float, default=1.0, help='가치 손실 가중'); ap.add_argument('--out', default='data/ai2/model_v0.pt')
ap.add_argument('--device', default='cpu')  # MPS는 torch 2.0에서 gather 경로 Bus error(실측) — CPU 기본
args = ap.parse_args()
random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model_def import Net, C, H, W, FLAT, MOVE  # 추론 서버(infer_server.py)와 공용
GRID = C * H * W

# ── 로드 ──
t_load = time.time()
rows, finals = [], {}
for fn in sorted(glob.glob(os.path.join(args.data, '*.jsonl.gz'))):
    with gzip.open(fn, 'rt') as f:
        for line in f:
            o = json.loads(line)
            if o.get('final'):
                if o.get('ended'): finals[o['g']] = o['scores']
                continue
            if o['y'] < 0 or not o['moves']: continue
            rows.append(o)
rows = [r for r in rows if r['g'] in finals]
def value_target(r):
    sc = finals[r['g']]; me = sc[r['p']]; others = [v for k, v in sc.items() if k != r['p']]
    return (me - sum(others) / max(1, len(others))) / 50.0
for r in rows: r['v'] = value_target(r)
games = sorted({r['g'].split('#')[0] for r in rows}); random.shuffle(games)
val_g = set(games[: max(1, len(games) // 5)])
tr = [r for r in rows if r['g'].split('#')[0] not in val_g]; va = [r for r in rows if r['g'].split('#')[0] in val_g]
print(f"결정 {len(rows)} (train {len(tr)} / val {len(va)}) · 시작상태 {len(games)} (val {len(val_g)}) · 게임 {len(finals)} · 평균 후보 {np.mean([len(r['moves']) for r in rows]):.1f}")
torch.set_num_threads(max(1, os.cpu_count() or 1))

print(f'로드 {time.time() - t_load:.0f}s', flush=True)
# 행 전처리: 희소 인덱스를 numpy로(배치마다 한 번에 index_put)
for r in rows:
    gi, gv = r['grid']; r['_gi'] = np.asarray(gi, np.int64); r['_gv'] = np.asarray(gv, np.float32)
    fi, fv = r['flat']; r['_fi'] = np.asarray(fi, np.int64); r['_fv'] = np.asarray(fv, np.float32)
    r['_mi'] = [np.asarray(m['f'][0], np.int64) for m in r['moves']]; r['_mv'] = [np.asarray(m['f'][1], np.float32) for m in r['moves']]
    r['_c'] = np.asarray([m['c'] for m in r['moves']], np.int64)
    del r['grid'], r['flat'], r['moves']

def batchify(rs, dev):
    B = len(rs); K = min(args.maxk, max(len(r['_c']) for r in rs))
    gI, gV, fI, fV, mI, mV = [], [], [], [], [], []
    cell = np.full((B, K), -1, np.int64); mask = np.zeros((B, K), bool); y = np.zeros(B, np.int64); v = np.zeros(B, np.float32)
    for b, r in enumerate(rs):
        gI.append(r['_gi'] + b * GRID); gV.append(r['_gv']); fI.append(r['_fi'] + b * FLAT); fV.append(r['_fv'])
        n = len(r['_c']); yy = r['y']; sel = list(range(n))
        if n > K:  # 정답은 반드시 남기고 나머지 무작위 표본
            sel = [yy] + random.sample([i for i in range(n) if i != yy], K - 1); yy = 0
        for k, i in enumerate(sel):
            mI.append(r['_mi'][i] + (b * K + k) * MOVE); mV.append(r['_mv'][i]); cell[b, k] = r['_c'][i]; mask[b, k] = True
        y[b] = yy; v[b] = r['v']
    g = torch.zeros(B * GRID); g[torch.from_numpy(np.concatenate(gI))] = torch.from_numpy(np.concatenate(gV))
    fl = torch.zeros(B * FLAT); fl[torch.from_numpy(np.concatenate(fI))] = torch.from_numpy(np.concatenate(fV))
    mv = torch.zeros(B * K * MOVE); mv[torch.from_numpy(np.concatenate(mI))] = torch.from_numpy(np.concatenate(mV))
    out = [g.view(B, C, H, W), fl.view(B, FLAT), mv.view(B, K, MOVE), torch.from_numpy(cell), torch.from_numpy(mask), torch.from_numpy(y), torch.from_numpy(v)]
    return [t.to(dev) for t in out]

dev = args.device
net = Net().to(dev); opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
def evaluate(rs):
    net.eval(); n = t1 = t3 = 0; ve, vs, vp = [], [], []
    with torch.no_grad():
        for i in range(0, len(rs), 128):
            g, fl, mv, cell, mask, y, v = batchify(rs[i:i + 128], dev)
            logit, val = net(g, fl, mv, cell, mask)
            top = logit.topk(min(3, logit.shape[1]), dim=1).indices
            t1 += (top[:, 0] == y).sum().item(); t3 += (top == y.unsqueeze(1)).any(1).sum().item(); n += len(y)
            vp += val.cpu().tolist(); vs += v.cpu().tolist()
    vp, vs = np.array(vp), np.array(vs)
    corr = float(np.corrcoef(vp, vs)[0, 1]) if len(vp) > 2 and vs.std() > 0 else 0.0
    return t1 / n, t3 / n, float(np.abs(vp - vs).mean() * 50), corr, float(((vp > 0) == (vs > 0)).mean()), float(np.abs(vs).mean() * 50)

rand_top1 = np.mean([1 / min(args.maxk, len(r['_c'])) for r in va])
print(f"기준선: 무작위 top-1 {rand_top1:.3f} · 가치 '항상 0' MAE {np.mean([abs(r['v']) for r in va]) * 50:.1f}VP")
for ep in range(args.epochs):
    net.train(); random.shuffle(tr); t0 = time.time(); tl = 0
    for i in range(0, len(tr), args.batch):
        g, fl, mv, cell, mask, y, v = batchify(tr[i:i + args.batch], dev)
        logit, val = net(g, fl, mv, cell, mask)
        loss = F.cross_entropy(logit, y) + args.vw * F.mse_loss(val, v)
        opt.zero_grad(); loss.backward(); opt.step(); tl += loss.item() * len(y)
    a1, a3, mae, corr, sign, _ = evaluate(va)
    print(f"ep{ep} loss {tl / len(tr):.3f} · val 정책 top-1 {a1:.3f} top-3 {a3:.3f} · 가치 MAE {mae:.1f}VP 상관 {corr:.2f} 부호 {sign:.2f} · {time.time() - t0:.0f}s")
os.makedirs(os.path.dirname(args.out), exist_ok=True)
torch.save({'state_dict': net.state_dict(), 'dims': {'C': C, 'H': H, 'W': W, 'FLAT': FLAT, 'MOVE': MOVE}}, args.out)
print('저장', args.out)
