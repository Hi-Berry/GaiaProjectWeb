#!/usr/bin/env python3
"""[ai2 실전 속도 2026-10-25] ONNX 모델 8비트 양자화(가중치 int8) — 운영 서버 CPU에서 추론을 빠르게.
  학습 환경(x86 anaconda)엔 onnxruntime 설치가 안 돼 전용 환경 사용:
    /usr/bin/python3 -m venv data/ai2/venv-quant && data/ai2/venv-quant/bin/pip install onnxruntime==1.19.2 onnx==1.16.2 numpy
  사용: data/ai2/venv-quant/bin/python scripts/ai2/quantize_onnx.py <입력.onnx> <출력.onnx> [dynamic|dynamic-matmul]
"""
import sys
from onnxruntime.quantization import quantize_dynamic, QuantType
src, dst = sys.argv[1], sys.argv[2]
mode = sys.argv[3] if len(sys.argv) > 3 else 'dynamic'
ops = ['MatMul', 'Gemm'] if mode == 'dynamic-matmul' else None  # 합성곱은 ConvInteger가 CPU에서 더 느릴 수 있어 선택지로
quantize_dynamic(src, dst, weight_type=QuantType.QInt8, op_types_to_quantize=ops)
import os
print('저장', dst, os.path.getsize(src), '→', os.path.getsize(dst), 'bytes')
