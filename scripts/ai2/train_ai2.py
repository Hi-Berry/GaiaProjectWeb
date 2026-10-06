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
ap.add_argument('--old', default='', help='[자기 강화] 섞을 이전 데이터 디렉터리(기존 봇 대국 등)'); ap.add_argument('--old-frac', type=float, default=0.3, help='--old 행 중 사용할 비율')
ap.add_argument('--init', default='', help='[자기 강화] 이어 학습할 체크포인트')
ap.add_argument('--val-starts', default='', help='검증 시작 상태 목록 고정(JSON) — 반복 간 같은 기준으로 비교하고 대결 시작 상태가 학습에 새지 않게')
ap.add_argument('--device', default='cpu')  # MPS는 torch 2.0에서 gather 경로 Bus error(실측) — CPU 기본
args = ap.parse_args()
random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model_def import Net, C, H, W, FLAT, MOVE  # 추론 서버(infer_server.py)와 공용
GRID = C * H * W

# ── 로드 ──
t_load = time.time()
rows, finals = [], {}
def compact(o):
    """메모리 절약: 희소 인덱스 int32·값 float16, 수 특징은 한 배열로 이어 붙이고 오프셋만 둔다.
    pi(자가대국 방문 비율)가 있으면 소프트 정책 목표로, 없으면 y(고른 수) 원-핫."""
    gi, gv = o['grid']; fi, fv = o['flat']
    lens = [len(m['f'][0]) for m in o['moves']]
    pi = o.get('pi')
    return {'g': o['g'], 'p': o['p'], 'y': o['y'],
            '_pii': np.asarray(pi[0], np.int32) if pi else None, '_piv': np.asarray(pi[1], np.float32) if pi else None,
            '_gi': np.asarray(gi, np.int32), '_gv': np.asarray(gv, np.float16),
            '_fi': np.asarray(fi, np.int32), '_fv': np.asarray(fv, np.float16),
            '_mi': np.asarray([i for m in o['moves'] for i in m['f'][0]], np.int32),
            '_mv': np.asarray([v for m in o['moves'] for v in m['f'][1]], np.float16),
            '_mo': np.concatenate([[0], np.cumsum(lens)]).astype(np.int32),
            '_c': np.asarray([m['c'] for m in o['moves']], np.int32)}
def load_dir(d, frac=1.0):
    n0 = len(rows)
    for fn in sorted(glob.glob(os.path.join(d, '*.jsonl.gz'))):
        with gzip.open(fn, 'rt') as f:
            for line in f:
                o = json.loads(line)
                if o.get('final'):
                    if o.get('ended'): finals[o['g']] = o['scores']
                    continue
                if o['y'] < 0 or not o['moves']: continue
                if frac < 1.0 and random.random() > frac: continue
                rows.append(compact(o))
    print(f'  {d}: {len(rows) - n0}행 (비율 {frac})', flush=True)
for d in args.data.split(','): load_dir(d)
if args.old: load_dir(args.old, args.old_frac)
rows = [r for r in rows if r['g'] in finals]
def value_target(r):
    sc = finals[r['g']]; me = sc[r['p']]; others = [v for k, v in sc.items() if k != r['p']]
    return (me - sum(others) / max(1, len(others))) / 50.0
for r in rows: r['v'] = value_target(r)
games = sorted({r['g'].split('#')[0] for r in rows}); random.shuffle(games)
val_g = set(json.load(open(args.val_starts))) if args.val_starts else set(games[: max(1, len(games) // 5)])
tr = [r for r in rows if r['g'].split('#')[0] not in val_g]; va = [r for r in rows if r['g'].split('#')[0] in val_g]
print(f"결정 {len(rows)} (train {len(tr)} / val {len(va)}) · 시작상태 {len(games)} (val {len(val_g)}) · 게임 {len(finals)} · 평균 후보 {np.mean([len(r['_c']) for r in rows]):.1f}")
# 검증 시작 상태 목록 저장 — 대결(script/ai2Match.ts --starts)은 학습에 안 쓴 시작 상태로만
os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
json.dump(sorted(val_g), open(args.out.replace('.pt', '.val_starts.json'), 'w'))
torch.set_num_threads(max(1, os.cpu_count() or 1))

print(f'로드 {time.time() - t_load:.0f}s', flush=True)
def batchify(rs, dev):
    B = len(rs); K = min(args.maxk, max(len(r['_c']) for r in rs))
    gI, gV, fI, fV, mI, mV = [], [], [], [], [], []
    cell = np.full((B, K), -1, np.int64); mask = np.zeros((B, K), bool); y = np.zeros(B, np.int64); v = np.zeros(B, np.float32)
    P = np.zeros((B, K), np.float32)  # 정책 목표 분포(소프트 pi 또는 y 원-핫)
    for b, r in enumerate(rs):
        gI.append(r['_gi'].astype(np.int64) + b * GRID); gV.append(r['_gv'].astype(np.float32)); fI.append(r['_fi'].astype(np.int64) + b * FLAT); fV.append(r['_fv'].astype(np.float32))
        n = len(r['_c']); yy = r['y']; sel = list(range(n))
        target = {int(i): float(w) for i, w in zip(r['_pii'], r['_piv'])} if r['_pii'] is not None else {yy: 1.0}
        if n > K:  # 목표가 있는 수는 반드시 남기고 나머지 무작위 표본
            keep = sorted(target, key=lambda i: -target[i])[:K]
            if yy not in keep: keep = [yy] + keep[:K - 1]
            rest = [i for i in range(n) if i not in keep]
            sel = keep + random.sample(rest, max(0, K - len(keep)))
            yy = sel.index(r['y'])
        for k, i in enumerate(sel):
            lo, hi = r['_mo'][i], r['_mo'][i + 1]
            mI.append(r['_mi'][lo:hi].astype(np.int64) + (b * K + k) * MOVE); mV.append(r['_mv'][lo:hi].astype(np.float32)); cell[b, k] = r['_c'][i]; mask[b, k] = True
        for k, i in enumerate(sel):
            if i in target: P[b, k] = target[i]
        if P[b].sum() <= 0: P[b, yy] = 1.0
        P[b] /= P[b].sum()
        y[b] = yy; v[b] = r['v']
    g = torch.zeros(B * GRID); g[torch.from_numpy(np.concatenate(gI))] = torch.from_numpy(np.concatenate(gV))
    fl = torch.zeros(B * FLAT); fl[torch.from_numpy(np.concatenate(fI))] = torch.from_numpy(np.concatenate(fV))
    mv = torch.zeros(B * K * MOVE); mv[torch.from_numpy(np.concatenate(mI))] = torch.from_numpy(np.concatenate(mV))
    out = [g.view(B, C, H, W), fl.view(B, FLAT), mv.view(B, K, MOVE), torch.from_numpy(cell), torch.from_numpy(mask), torch.from_numpy(y), torch.from_numpy(v), torch.from_numpy(P)]
    return [t.to(dev) for t in out]

dev = args.device
net = Net().to(dev)
if args.init:
    net.load_state_dict(torch.load(args.init, map_location='cpu')['state_dict']); print('이어 학습:', args.init, flush=True)
opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
def evaluate(rs):
    net.eval(); n = t1 = t3 = 0; ve, vs, vp = [], [], []
    with torch.no_grad():
        for i in range(0, len(rs), 128):
            g, fl, mv, cell, mask, y, v, _P = batchify(rs[i:i + 128], dev)
            logit, val = net(g, fl, mv, cell, mask)
            top = logit.topk(min(3, logit.shape[1]), dim=1).indices
            t1 += (top[:, 0] == y).sum().item(); t3 += (top == y.unsqueeze(1)).any(1).sum().item(); n += len(y)
            vp += val.cpu().tolist(); vs += v.cpu().tolist()
    vp, vs = np.array(vp), np.array(vs)
    corr = float(np.corrcoef(vp, vs)[0, 1]) if len(vp) > 2 and vs.std() > 0 else 0.0
    return t1 / n, t3 / n, float(np.abs(vp - vs).mean() * 50), corr, float(((vp > 0) == (vs > 0)).mean()), float(np.abs(vs).mean() * 50)

rand_top1 = np.mean([1 / min(args.maxk, len(r['_c'])) for r in va])
print(f"기준선: 무작위 top-1 {rand_top1:.3f} · 가치 '항상 0' MAE {np.mean([abs(r['v']) for r in va]) * 50:.1f}VP")
best = -1e9
for ep in range(args.epochs):
    net.train(); random.shuffle(tr); t0 = time.time(); tl = 0
    for i in range(0, len(tr), args.batch):
        g, fl, mv, cell, mask, y, v, P = batchify(tr[i:i + args.batch], dev)
        logit, val = net(g, fl, mv, cell, mask)
        pol = -(P * F.log_softmax(logit, dim=-1)).sum(-1).mean()  # 소프트 목표 CE(원-핫이면 기존 CE와 같음)
        loss = pol + args.vw * F.mse_loss(val, v)
        opt.zero_grad(); loss.backward(); opt.step(); tl += loss.item() * len(y)
    a1, a3, mae, corr, sign, _ = evaluate(va)
    print(f"ep{ep} loss {tl / len(tr):.3f} · val 정책 top-1 {a1:.3f} top-3 {a3:.3f} · 가치 MAE {mae:.1f}VP 상관 {corr:.2f} 부호 {sign:.2f} · {time.time() - t0:.0f}s", flush=True)
    score = a1 + corr  # 정책 정확도 + 가치 상관 — 둘 다 나아질 때 갱신
    if score > best:
        best = score; torch.save({'state_dict': net.state_dict(), 'epoch': ep, 'val': {'top1': a1, 'top3': a3, 'mae': mae, 'corr': corr}}, args.out)
        print(f'  → 최고 갱신, 저장 {args.out}', flush=True)
print('완료 — 최고 모델', args.out)
