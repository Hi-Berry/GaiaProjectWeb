#!/usr/bin/env python3
"""후보 집합 softmax MLP 랭커 학습 — decisions.npz → policy.json(가중치) + 라운드별 top-1/마진 캘리브레이션.
  python3 train_policy.py --data data/humanPolicy [--epochs 40] [--hidden 128]
게임 단위 홀드아웃(20%). 점수 = MLP([state, cand]) → 후보 집합 내 softmax → CE.
"""
import json, os, argparse, numpy as np, torch, torch.nn as nn

ap = argparse.ArgumentParser()
ap.add_argument('--data', default='data/humanPolicy'); ap.add_argument('--epochs', type=int, default=40)
ap.add_argument('--hidden', type=int, default=128); ap.add_argument('--lr', type=float, default=2e-3); ap.add_argument('--seed', type=int, default=0)
ap.add_argument('--dropout', type=float, default=0.0); ap.add_argument('--wd', type=float, default=1e-5); ap.add_argument('--out', default='policy.json')
# [2026-09-22 라벨 품질 실험] 학습 행 필터: 결정자 최종 점수 ≥ min-vp 또는 게임 내 순위 ≤ top-rank. 검증 집합은 필터하지 않는다(모델 간 비교 기준 고정).
ap.add_argument('--min-vp', type=int, default=0); ap.add_argument('--top-rank', type=int, default=0)
args = ap.parse_args()
torch.manual_seed(args.seed); np.random.seed(args.seed)
z = np.load(os.path.join(args.data, 'decisions.npz'))
Xs, Xc, mask, y, game, rnd, ncand = z['X_s'], z['X_c'], z['mask'], z['y'], z['game'], z['round'], z['ncand']
games = np.unique(game); rng = np.random.RandomState(args.seed); rng.shuffle(games)
val_games = set(games[: max(1, len(games) // 5)].tolist())
va = np.array([g in val_games for g in game]); tr = ~va
seat_vp = z['seat_vp'] if 'seat_vp' in z.files else np.zeros(len(y)); seat_rank = z['seat_rank'] if 'seat_rank' in z.files else np.zeros(len(y))
hq = np.ones(len(y), bool)
if args.min_vp: hq &= seat_vp >= args.min_vp
if args.top_rank: hq &= (seat_rank > 0) & (seat_rank <= args.top_rank)
tr_all = tr.copy(); tr = tr & hq
print(f"decisions {len(y)} | train {tr.sum()} (필터 전 {tr_all.sum()}, min-vp {args.min_vp} top-rank {args.top_rank}) val {va.sum()} | games {len(games)} (val {len(val_games)}) | state {Xs.shape[1]} cand {Xc.shape[2]}")

class Ranker(nn.Module):
    def __init__(self, sd, cd, h):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(sd + cd, h), nn.ReLU(), nn.Dropout(args.dropout), nn.Linear(h, h), nn.ReLU(), nn.Dropout(args.dropout), nn.Linear(h, 1))
    def forward(self, s, c, m):  # s: (B,sd) c: (B,K,cd) m: (B,K)
        x = torch.cat([s.unsqueeze(1).expand(-1, c.shape[1], -1), c], dim=-1)
        logit = self.net(x).squeeze(-1)
        return logit.masked_fill(~m, -1e9)

dev = 'cpu'
S = torch.tensor(Xs); C = torch.tensor(Xc); M = torch.tensor(mask); Y = torch.tensor(y)
model = Ranker(Xs.shape[1], Xc.shape[2], args.hidden); opt = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=args.wd)
tri = np.where(tr)[0]; vai = np.where(va)[0]

def evaluate(idx):
    model.eval()
    with torch.no_grad():
        lg = model(S[idx], C[idx], M[idx]); p = torch.softmax(lg, -1)
        top = p.argmax(-1); correct = (top == Y[idx]).numpy()
        srt = p.sort(-1, descending=True).values; margin = (srt[:, 0] - srt[:, 1]).numpy()
    model.train()
    return correct, margin, top.numpy()

best = None
for ep in range(args.epochs):
    perm = rng.permutation(tri); tot = 0.0
    for i in range(0, len(perm), 256):
        b = torch.tensor(perm[i:i + 256])
        lg = model(S[b], C[b], M[b]); loss = nn.functional.cross_entropy(lg, Y[b])
        opt.zero_grad(); loss.backward(); opt.step(); tot += loss.item() * len(b)
    ctr, _, _ = evaluate(tri[:5000]); cva, mva, _ = evaluate(vai)
    acc = cva.mean()
    if best is None or acc > best[0]:
        best = (acc, {k: v.detach().clone() for k, v in model.state_dict().items()}, ep)
    if ep % 5 == 0 or ep == args.epochs - 1:
        print(f"ep {ep:2d} loss {tot / len(perm):.3f} | train top1 {ctr.mean():.3f} | val top1 {acc:.3f}")
model.load_state_dict(best[1]); print(f"best val top1 {best[0]:.3f} @ep{best[2]}")
cva, mva, topva = evaluate(vai)
rand = (1.0 / ncand[vai]).mean(); first = (y[vai] == 0).mean()
print(f"val: top1 {cva.mean():.3f} | 무작위 {rand:.3f} | 봇순서[0]={first:.3f}")
hv = hq[vai]
if hv.sum() and (~hv).sum(): print(f"val 고득점 부분집합(필터 조건 충족) n={hv.sum()} top1 {cva[hv].mean():.3f} | 나머지 n={(~hv).sum()} top1 {cva[~hv].mean():.3f}")
for r in range(1, 7):
    sel = rnd[vai] == r
    if sel.sum(): print(f"  R{r} n={sel.sum():5d} top1 {cva[sel].mean():.3f}")
print("마진 구간(>=)  커버  정확도")
for th in (0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7):
    sel = mva >= th
    print(f"  >={th:.1f}  {sel.mean():5.1%}  {cva[sel].mean() if sel.sum() else 0:.3f}")
# export
W = {k.replace('net.3.', 'net.2.').replace('net.6.', 'net.4.'): v.numpy().tolist() for k, v in model.state_dict().items()}  # Dropout 층 번호를 학습 없는 구조(0/2/4)로 정규화
meta = json.load(open(os.path.join(args.data, 'meta.json')))
json.dump({'arch': 'mlp2', 'hidden': args.hidden, 'state_dim': int(Xs.shape[1]), 'cand_dim': int(Xc.shape[2]), 'weights': W, 'val_top1': float(cva.mean()), 'meta': meta}, open(os.path.join(args.data, args.out), 'w'))
print("saved", os.path.join(args.data, args.out))
