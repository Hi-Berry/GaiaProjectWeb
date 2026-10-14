#!/usr/bin/env python3
"""[ai2 실전 2026-10-14] 학습된 .pt → .onnx (운영 서버는 CPU 1개·메모리 1GB라 torch 불가 → Node에서 onnxruntime-node로 추론).
  입력: g(B,C,H,W) fl(B,FLAT) mv(B,K,MOVE) cell(B,K) int64 mask(B,K) bool   출력: logit(B,K) value(B)
  python3 scripts/ai2/export_onnx.py data/ai2/model_v4h4.pt server/ai2/models/ai2_v4h4.onnx
"""
import sys, os, torch
# 이 맥의 파이썬(x86 에뮬레이션)엔 onnx 패키지 바이너리가 없다. torch 2.0 내보내기는 onnx를 사용자 정의 onnxscript 함수
# 덧붙이기에만 쓰므로(우리 모델엔 없음) 그 단계를 건너뛴다.
try:
    import onnx  # noqa: F401
except ImportError:
    import torch.onnx._internal.onnx_proto_utils as _u
    _u._add_onnxscript_fn = lambda model_bytes, custom_opsets: model_bytes
sys.path.insert(0, os.path.dirname(__file__))
from model_def import Net, C, H, W, FLAT, MOVE  # noqa: E402

src, dst = sys.argv[1], sys.argv[2]
net = Net(); net.load_state_dict(torch.load(src, map_location='cpu')['state_dict']); net.eval()
B, K = 2, 5
args = (torch.zeros(B, C, H, W), torch.zeros(B, FLAT), torch.zeros(B, K, MOVE), torch.full((B, K), -1, dtype=torch.long), torch.ones(B, K, dtype=torch.bool))
os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
torch.onnx.export(net, args, dst, input_names=['g', 'fl', 'mv', 'cell', 'mask'], output_names=['logit', 'value'],
                  dynamic_axes={'g': {0: 'B'}, 'fl': {0: 'B'}, 'mv': {0: 'B', 1: 'K'}, 'cell': {0: 'B', 1: 'K'}, 'mask': {0: 'B', 1: 'K'}, 'logit': {0: 'B', 1: 'K'}, 'value': {0: 'B'}},
                  opset_version=13)
print('저장', dst, os.path.getsize(dst), 'bytes')
