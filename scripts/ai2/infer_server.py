#!/usr/bin/env python3
"""[ai2 2026-10-05] 정책·가치망 추론 서버 — stdin/stdout JSON 한 줄 프로토콜(server/ai2/netClient.ts가 띄움).
  요청: {"id": n, "items": [{"flat": [idx, val], "grid": [idx, val], "moves": [{"f": [idx, val], "c": cell}, ...]}, ...]}
  응답: {"id": n, "out": [{"logits": [...], "value": v}, ...]}   (value = (내 최종 − 상대 평균)/50 예측)
  python3 -u scripts/ai2/infer_server.py data/ai2/model_v0.pt
"""
import json, sys, os
import numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
torch.set_num_threads(int(os.environ.get('AI2_TORCH_THREADS', '1')))
from model_def import Net, C, H, W, FLAT, MOVE  # noqa: E402

ck = torch.load(sys.argv[1], map_location='cpu')
net = Net(); net.load_state_dict(ck['state_dict']); net.eval()
GRID = C * H * W

def batch(items):
    B = len(items); K = max(1, max(len(it['moves']) for it in items))
    g = torch.zeros(B * GRID); fl = torch.zeros(B * FLAT); mv = torch.zeros(B * K * MOVE)
    cell = torch.full((B, K), -1, dtype=torch.long); mask = torch.zeros(B, K, dtype=torch.bool)
    for b, it in enumerate(items):
        gi, gv = it['grid']
        if gi: g[torch.tensor(gi) + b * GRID] = torch.tensor(gv, dtype=torch.float32)
        fi, fv = it['flat']
        if fi: fl[torch.tensor(fi) + b * FLAT] = torch.tensor(fv, dtype=torch.float32)
        for k, m in enumerate(it['moves']):
            mi, mvv = m['f']
            if mi: mv[torch.tensor(mi) + (b * K + k) * MOVE] = torch.tensor(mvv, dtype=torch.float32)
            cell[b, k] = m['c']; mask[b, k] = True
    return g.view(B, C, H, W), fl.view(B, FLAT), mv.view(B, K, MOVE), cell, mask

for line in sys.stdin:
    req = json.loads(line)
    items = req['items']
    with torch.no_grad():
        logit, val = net(*batch(items))
    out = [{'logits': logit[b, :len(it['moves'])].tolist(), 'value': float(val[b])} for b, it in enumerate(items)]
    sys.stdout.write(json.dumps({'id': req['id'], 'out': out}) + '\n'); sys.stdout.flush()
