"""[ai2] 정책·가치망 정의 — train_ai2.py·infer_server.py 공용(차원은 server/ai2/encoder.ts와 일치해야 함)."""
import torch, torch.nn as nn

C, H, W = 51, 20, 24; FLAT = 1091; MOVE = 203


class Net(nn.Module):
    def __init__(self, ch=64, emb=256):
        super().__init__()
        self.conv = nn.Sequential(nn.Conv2d(C, ch, 3, padding=1), nn.ReLU(), nn.Conv2d(ch, ch, 3, padding=1), nn.ReLU(), nn.Conv2d(ch, ch, 3, padding=1), nn.ReLU())
        self.flat = nn.Sequential(nn.Linear(FLAT, 256), nn.ReLU(), nn.Linear(256, 256), nn.ReLU())
        self.state = nn.Sequential(nn.Linear(ch + 256, emb), nn.ReLU())
        self.move = nn.Sequential(nn.Linear(MOVE + ch, 128), nn.ReLU())
        self.pol = nn.Sequential(nn.Linear(emb + 128, 128), nn.ReLU(), nn.Linear(128, 1))
        self.val = nn.Sequential(nn.Linear(emb, 64), nn.ReLU(), nn.Linear(64, 1))
        self.ch = ch
    def forward(self, g, fl, mv, cell, mask):
        fm = self.conv(g)                                   # B,ch,H,W
        B, K = cell.shape
        gpool = fm.mean(dim=(2, 3))
        s = self.state(torch.cat([gpool, self.flat(fl)], -1))  # B,emb
        flatfm = fm.view(B, self.ch, H * W).transpose(1, 2)    # B,HW,ch
        safe = cell.clamp(min=0)
        cf = torch.gather(flatfm, 1, safe.unsqueeze(-1).expand(-1, -1, self.ch)) * (cell >= 0).unsqueeze(-1).float()
        me = self.move(torch.cat([mv, cf], -1))              # B,K,128
        logit = self.pol(torch.cat([s.unsqueeze(1).expand(-1, K, -1), me], -1)).squeeze(-1).masked_fill(~mask, -1e9)
        return logit, self.val(s).squeeze(-1)

