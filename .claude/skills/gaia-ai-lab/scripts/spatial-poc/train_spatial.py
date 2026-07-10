#!/usr/bin/env python3
"""
Phase 2b SPATIAL value-net distillation reprobe (CPU torch).

Trains a small GraphSAGE-style GNN over the game-board tile graph to predict the heuristic
leaf score of each resulting candidate board, then measures whether it reproduces the
heuristic's SIBLING ranking per decision (top-1 argmax agreement, top-3, Spearman).

Data: data/spatial-probe.jsonl (from script/spatialProbeRun.mjs). Split BY DECISION 80/20.

Baseline to beat: scalar-feature ceiling = top-1 ~65% (Spearman 0.69).
GATE: spatial top-1 >= ~85% => spatial features break the feature ceiling => GO.

Usage: python script/train_spatial.py [--file data/spatial-probe.jsonl] [--hidden 64]
       [--layers 2] [--epochs 40] [--batch 64] [--max-decisions N]
"""
import argparse, json, math, time, sys
import numpy as np
import torch
import torch.nn as nn

N_PTYPE = 19
N_STRUCT = 8
N_OWNER = 3
N_FLAGS = 8
PER_TILE_IN = N_PTYPE + N_STRUCT + N_OWNER + N_FLAGS + 1  # + sector scalar = 39
GLOBAL_DIM = 33
# planet-type indices (see spatialProbe.ts PLANET_TYPES): terra..gaia (0-8), proto(17), lost_planet(18)
PLANET_IDX_SET = np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 17, 18], dtype=np.int64)


def build_edges(coords):
    """coords: (n,2) int axial q,r. Return undirected edge_index (2,E) for hex-distance-1 pairs."""
    q = coords[:, 0].astype(np.int64)
    r = coords[:, 1].astype(np.int64)
    pos = {(int(q[i]), int(r[i])): i for i in range(len(q))}
    # 6 axial neighbor offsets
    NB = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)]
    src, dst = [], []
    for i in range(len(q)):
        for dq, dr in NB:
            j = pos.get((int(q[i]) + dq, int(r[i]) + dr))
            if j is not None:
                src.append(i); dst.append(j)
    if not src:
        return np.zeros((2, 0), dtype=np.int64)
    return np.array([src, dst], dtype=np.int64)


def tile_feats(tiles):
    """tiles: (n,5) int -> (n, PER_TILE_IN) float one-hot expansion. Expanded per-batch only (lean mem)."""
    n = tiles.shape[0]
    x = np.zeros((n, PER_TILE_IN), dtype=np.float32)
    ptype = np.clip(tiles[:, 0], 0, N_PTYPE - 1)
    struct = np.clip(tiles[:, 1], 0, N_STRUCT - 1)
    owner = np.clip(tiles[:, 2], 0, N_OWNER - 1)
    flags = tiles[:, 3].astype(np.int64)
    sector = tiles[:, 4].astype(np.float32)
    rows = np.arange(n)
    x[rows, ptype] = 1.0
    x[rows, N_PTYPE + struct] = 1.0
    x[rows, N_PTYPE + N_STRUCT + owner] = 1.0
    base = N_PTYPE + N_STRUCT + N_OWNER
    for b in range(N_FLAGS):
        x[:, base + b] = ((flags >> b) & 1).astype(np.float32)
    x[:, base + N_FLAGS] = sector / 10.0
    return x


def load(path, max_decisions=0):
    # Store COMPACT ints per candidate (expand to one-hot only per batch) to bound memory.
    decisions = []  # each: {edges:(2,E) int32, tiles:[ (n,5) int16 ], g:(nc,33) f32, y:(nc,) f32}
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            heur = d.get('heur')
            if not heur or len(heur) < 2:
                continue
            coords = np.array(d['coords'], dtype=np.int64)
            edges = build_edges(coords).astype(np.int64)
            tiles = [np.array(d['tiles'][c], dtype=np.int16) for c in range(len(heur))]
            # Prune far empty-space nodes: keep planet tiles + their distance-1 neighbors.
            # (planet type indices; ptype is static across candidates -> use tiles[0])
            ptype0 = tiles[0][:, 0].astype(np.int64)
            is_planet = np.isin(ptype0, PLANET_IDX_SET)
            keep = is_planet.copy()
            if edges.shape[1]:
                # a tile is kept if it neighbors a planet
                nbr_planet = np.zeros(len(ptype0), dtype=bool)
                s, dd = edges[0], edges[1]
                nbr_planet[dd[is_planet[s]]] = True
                keep = keep | nbr_planet
            if keep.sum() < len(keep):
                remap = -np.ones(len(keep), dtype=np.int64)
                remap[keep] = np.arange(int(keep.sum()))
                tiles = [t[keep] for t in tiles]
                if edges.shape[1]:
                    em = keep[edges[0]] & keep[edges[1]]
                    edges = np.stack([remap[edges[0][em]], remap[edges[1][em]]], 0)
                else:
                    edges = np.zeros((2, 0), dtype=np.int64)
            edges = edges.astype(np.int32)
            g = np.array(d['global'], dtype=np.float32)
            decisions.append({'edges': edges, 'tiles': tiles, 'g': g,
                              'y': np.array(heur, dtype=np.float32)})
            if max_decisions and len(decisions) >= max_decisions:
                break
    return decisions


class SAGEConv(nn.Module):
    def __init__(self, cin, cout):
        super().__init__()
        self.lin_self = nn.Linear(cin, cout)
        self.lin_neigh = nn.Linear(cin, cout)

    def forward(self, x, edge_index, deg):
        # mean aggregation of neighbors
        src, dst = edge_index[0], edge_index[1]
        agg = torch.zeros_like(x)
        agg.index_add_(0, dst, x[src])
        agg = agg / deg.clamp(min=1).unsqueeze(1)
        return self.lin_self(x) + self.lin_neigh(agg)


class SpatialNet(nn.Module):
    def __init__(self, hidden=64, layers=2):
        super().__init__()
        self.enc = nn.Linear(PER_TILE_IN, hidden)
        self.convs = nn.ModuleList([SAGEConv(hidden, hidden) for _ in range(layers)])
        self.act = nn.ReLU()
        # pooled = mean+max over nodes (2*hidden) concat global (GLOBAL_DIM)
        self.head = nn.Sequential(
            nn.Linear(2 * hidden + GLOBAL_DIM, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden // 2), nn.ReLU(),
            nn.Linear(hidden // 2, 1),
        )

    def forward(self, x, edge_index, deg, batch, n_graphs, g):
        h = self.act(self.enc(x))
        for conv in self.convs:
            h = self.act(conv(h, edge_index, deg))
        # pooling per graph
        hidden = h.shape[1]
        mean = torch.zeros(n_graphs, hidden)
        cnt = torch.zeros(n_graphs, 1)
        mean.index_add_(0, batch, h)
        cnt.index_add_(0, batch, torch.ones(h.shape[0], 1))
        mean = mean / cnt.clamp(min=1)
        mx = torch.full((n_graphs, hidden), -1e9)
        mx.index_reduce_(0, batch, h, 'amax', include_self=True)
        mx = mx.clamp(min=-1e8)  # graphs with no nodes stay large-neg -> clamp (shouldn't happen)
        pooled = torch.cat([mean, mx, g], dim=1)
        return self.head(pooled).squeeze(1)


def collate(decisions, idxs, cand_pick=None):
    """Build a batched graph over selected (decision, candidate) pairs.
    cand_pick: optional list parallel to idxs giving which candidate index; else all candidates."""
    tiles_int, gs, ys = [], [], []
    edge_src, edge_dst = [], []
    batch = []
    node_off = 0
    gi = 0
    meta = []  # (decision_index, cand_index) for grouping
    for di in idxs:
        d = decisions[di]
        e = d['edges']
        for c in range(len(d['tiles'])):
            ti = d['tiles'][c]
            n = ti.shape[0]
            tiles_int.append(ti)
            gs.append(d['g'][c])
            ys.append(d['y'][c])
            if e.shape[1]:
                edge_src.append(e[0].astype(np.int64) + node_off)
                edge_dst.append(e[1].astype(np.int64) + node_off)
            batch.append(np.full(n, gi, dtype=np.int64))
            meta.append((di, c))
            node_off += n
            gi += 1
    # single vectorized one-hot expansion for the whole batch
    X = torch.from_numpy(tile_feats(np.concatenate(tiles_int, 0).astype(np.int64)))
    G = torch.from_numpy(np.stack(gs, 0))
    Y = torch.from_numpy(np.array(ys, dtype=np.float32))
    if edge_src:
        ei = torch.from_numpy(np.stack([np.concatenate(edge_src), np.concatenate(edge_dst)], 0))
    else:
        ei = torch.zeros((2, 0), dtype=torch.long)
    B = torch.from_numpy(np.concatenate(batch))
    deg = torch.zeros(X.shape[0])
    if ei.shape[1]:
        deg.index_add_(0, ei[1], torch.ones(ei.shape[1]))
    return X, ei, deg, B, gi, G, Y, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default='data/spatial-probe.jsonl')
    ap.add_argument('--hidden', type=int, default=64)
    ap.add_argument('--layers', type=int, default=2)
    ap.add_argument('--epochs', type=int, default=40)
    ap.add_argument('--batch', type=int, default=48)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--max-decisions', type=int, default=0)
    ap.add_argument('--eval-every', type=int, default=3)
    args = ap.parse_args()
    torch.manual_seed(0)
    np.random.seed(0)

    t0 = time.time()
    decisions = load(args.file, args.max_decisions)
    print(f'loaded {len(decisions)} decisions ({sum(len(d["tiles"]) for d in decisions)} candidate states) in {time.time()-t0:.1f}s')
    if len(decisions) < 50:
        print('too few decisions'); sys.exit(1)

    # split by decision 80/20 (deterministic: every 5th to val)
    idx = np.arange(len(decisions))
    val_idx = idx[idx % 5 == 0]
    train_idx = idx[idx % 5 != 0]
    print(f'train decisions={len(train_idx)} val decisions={len(val_idx)}')

    # global target normalization from train candidates
    all_y = np.concatenate([decisions[i]['y'] for i in train_idx])
    ymean, ystd = float(all_y.mean()), float(all_y.std() + 1e-6)
    print(f'target: mean={ymean:.2f} std={ystd:.2f}')

    net = SpatialNet(args.hidden, args.layers)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr, weight_decay=1e-5)
    lossf = nn.MSELoss()
    nparams = sum(p.numel() for p in net.parameters())
    print(f'net params={nparams} hidden={args.hidden} layers={args.layers}')

    def run_batches(indices, train):
        net.train(train)
        order = np.array(indices)
        if train:
            np.random.shuffle(order)
        tot_loss, tot_n = 0.0, 0
        for s in range(0, len(order), args.batch):
            bidx = order[s:s + args.batch]
            X, ei, deg, B, ng, G, Y, meta = collate(decisions, bidx)
            Yn = (Y - ymean) / ystd
            pred = net(X, ei, deg, B, ng, G)
            loss = lossf(pred, Yn)
            if train:
                opt.zero_grad(); loss.backward(); opt.step()
            tot_loss += loss.item() * ng; tot_n += ng
        return tot_loss / max(tot_n, 1)

    @torch.no_grad()
    def evaluate(indices):
        net.eval()
        # predict per decision, compute ranking metrics + MAE
        top1 = top1t = top3 = tot = 0
        rho_sum = 0.0; rho_n = 0
        abs_err = 0.0; err_n = 0
        for s in range(0, len(indices), args.batch):
            bidx = indices[s:s + args.batch]
            X, ei, deg, B, ng, G, Y, meta = collate(decisions, bidx)
            Yn = (Y - ymean) / ystd
            pred = net(X, ei, deg, B, ng, G)
            abs_err += float((pred - Yn).abs().sum()) ; err_n += ng
            # group by decision
            from collections import defaultdict
            groups = defaultdict(list)
            for k, (di, c) in enumerate(meta):
                groups[di].append((c, float(pred[k]), float(Y[k])))
            for di, lst in groups.items():
                lst.sort(key=lambda t: t[0])
                pv = [t[1] for t in lst]
                hv = [t[2] for t in lst]
                pa = int(np.argmax(pv)); ha = int(np.argmax(hv))
                if pa == ha: top1 += 1
                if hv[pa] >= max(hv) - 1e-6: top1t += 1  # tie-aware: picked a heuristic-best move
                order_h = list(np.argsort(hv)[::-1][:3])
                if pa in order_h: top3 += 1
                tot += 1
                if len(hv) >= 3:
                    rho_sum += spearman(pv, hv); rho_n += 1
        mae_norm = abs_err / max(err_n, 1)
        return (100 * top1 / tot, 100 * top1t / tot, 100 * top3 / tot, rho_sum / max(rho_n, 1),
                mae_norm, mae_norm * ystd, tot)

    best = None
    for ep in range(1, args.epochs + 1):
        te = time.time()
        tr_loss = run_batches(list(train_idx), True)
        ev_every = getattr(args, 'eval_every', 3)
        if ep % ev_every == 0 or ep == 1 or ep == args.epochs:
            t1, t1t, t3, rho, mae_n, mae_raw, n = evaluate(list(val_idx))
            print(f'ep{ep:3d} train_mse={tr_loss:.4f} val_MAE(raw)={mae_raw:.1f} '
                  f'top1={t1:.1f}% top1_tieaware={t1t:.1f}% top3={t3:.1f}% rho={rho:.3f} ({time.time()-te:.1f}s)')
            if best is None or t1 > best[0]:
                best = (t1, t1t, t3, rho, mae_raw, ep)

    print('\n===== SPATIAL DISTILL REPROBE RESULT =====')
    print('scalar baseline ceiling: strict top-1 ~65% (Spearman 0.69); raw-net Phase1: 36%')
    print(f'BEST val: strict top-1={best[0]:.1f}%  tie-aware top-1={best[1]:.1f}%  top-3={best[2]:.1f}%  '
          f'Spearman={best[3]:.3f}  MAE(raw)={best[4]:.1f}  @ep{best[5]}')
    verdict = 'GO (spatial breaks the ceiling)' if best[0] >= 85 else (
        'PROMISING-BUT-PARTIAL' if best[0] >= 70 else 'NO-GO (no clear gain over scalar ceiling)')
    print(f'VERDICT (strict top-1 vs 65%): {verdict}')


def spearman(a, b):
    a = np.asarray(a); b = np.asarray(b)
    ra = a.argsort().argsort().astype(np.float64)
    rb = b.argsort().argsort().astype(np.float64)
    n = len(a)
    d2 = float(((ra - rb) ** 2).sum())
    if n < 2:
        return 0.0
    return 1 - 6 * d2 / (n * (n * n - 1))


if __name__ == '__main__':
    main()
