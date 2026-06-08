/**
 * 가치망(Value Network) — 순수 TS MLP. 의존성 없음.
 * 입력: features.ts의 정규화 특징 벡터(FEATURE_DIM). 출력: 그 플레이어의 예상 최종 VP(/100 스케일).
 * 구조: IN -> 32(ReLU) -> 16(ReLU) -> 1(linear). MSE 회귀, SGD+momentum.
 *
 * 비선형이므로 가중치 튜닝(선형 가중합, head2head null)이 못 잡는 특징 상호작용을 학습할 수 있다.
 * 학습된 가중치는 JSON으로 저장(server/ai/valueNet.json), MCTS 리프 평가에 연결(flag useValueNet).
 */
import { FEATURE_DIM } from './features';

const H1 = 32;
const H2 = 16;

type Mat = Float64Array; // row-major

function randMat(rows: number, cols: number, scale: number): Mat {
    const m = new Float64Array(rows * cols);
    for (let i = 0; i < m.length; i++) m[i] = (Math.random() * 2 - 1) * scale;
    return m;
}

export type ValueNetWeights = {
    dim: number; h1: number; h2: number;
    W1: number[]; b1: number[];
    W2: number[]; b2: number[];
    W3: number[]; b3: number[];
};

export class ValueNet {
    dim: number; h1: number; h2: number;
    W1: Mat; b1: Mat; W2: Mat; b2: Mat; W3: Mat; b3: Mat;
    // momentum buffers
    private vW1: Mat; private vb1: Mat; private vW2: Mat; private vb2: Mat; private vW3: Mat; private vb3: Mat;

    constructor(dim = FEATURE_DIM) {
        this.dim = dim; this.h1 = H1; this.h2 = H2;
        // He 초기화
        this.W1 = randMat(H1, dim, Math.sqrt(2 / dim));
        this.b1 = new Float64Array(H1);
        this.W2 = randMat(H2, H1, Math.sqrt(2 / H1));
        this.b2 = new Float64Array(H2);
        this.W3 = randMat(1, H2, Math.sqrt(2 / H2));
        this.b3 = new Float64Array(1);
        this.vW1 = new Float64Array(this.W1.length); this.vb1 = new Float64Array(H1);
        this.vW2 = new Float64Array(this.W2.length); this.vb2 = new Float64Array(H2);
        this.vW3 = new Float64Array(this.W3.length); this.vb3 = new Float64Array(1);
    }

    private fwd(x: number[]) {
        const z1 = new Float64Array(this.h1);
        for (let i = 0; i < this.h1; i++) {
            let s = this.b1[i];
            const off = i * this.dim;
            for (let j = 0; j < this.dim; j++) s += this.W1[off + j] * x[j];
            z1[i] = s;
        }
        const a1 = new Float64Array(this.h1);
        for (let i = 0; i < this.h1; i++) a1[i] = z1[i] > 0 ? z1[i] : 0;

        const z2 = new Float64Array(this.h2);
        for (let i = 0; i < this.h2; i++) {
            let s = this.b2[i];
            const off = i * this.h1;
            for (let j = 0; j < this.h1; j++) s += this.W2[off + j] * a1[j];
            z2[i] = s;
        }
        const a2 = new Float64Array(this.h2);
        for (let i = 0; i < this.h2; i++) a2[i] = z2[i] > 0 ? z2[i] : 0;

        let y = this.b3[0];
        for (let j = 0; j < this.h2; j++) y += this.W3[j] * a2[j];
        return { z1, a1, z2, a2, y };
    }

    /** 예측: 최종 VP(스케일 해제). */
    predict(x: number[]): number {
        return this.fwd(x).y * 100;
    }

    /** 한 샘플 SGD 스텝. target은 실제 최종 VP. 반환: 제곱오차(스케일된). */
    trainStep(x: number[], target: number, lr: number, momentum = 0.9): number {
        const t = target / 100;
        const { a1, z1, a2, z2, y } = this.fwd(x);
        const err = y - t;            // dL/dy (MSE, 1/2 생략)
        // output layer grads
        const gW3 = new Float64Array(this.h2);
        for (let j = 0; j < this.h2; j++) gW3[j] = err * a2[j];
        const gb3 = err;
        // backprop into a2
        const da2 = new Float64Array(this.h2);
        for (let j = 0; j < this.h2; j++) da2[j] = err * this.W3[j];
        const dz2 = new Float64Array(this.h2);
        for (let j = 0; j < this.h2; j++) dz2[j] = z2[j] > 0 ? da2[j] : 0;
        // W2 grads
        const gW2 = new Float64Array(this.W2.length);
        for (let i = 0; i < this.h2; i++) { const off = i * this.h1; for (let j = 0; j < this.h1; j++) gW2[off + j] = dz2[i] * a1[j]; }
        // backprop into a1
        const da1 = new Float64Array(this.h1);
        for (let j = 0; j < this.h1; j++) { let s = 0; for (let i = 0; i < this.h2; i++) s += this.W2[i * this.h1 + j] * dz2[i]; da1[j] = s; }
        const dz1 = new Float64Array(this.h1);
        for (let j = 0; j < this.h1; j++) dz1[j] = z1[j] > 0 ? da1[j] : 0;
        const gW1 = new Float64Array(this.W1.length);
        for (let i = 0; i < this.h1; i++) { const off = i * this.dim; for (let j = 0; j < this.dim; j++) gW1[off + j] = dz1[i] * x[j]; }

        // SGD + momentum update
        const upd = (W: Mat, g: Mat, v: Mat) => { for (let k = 0; k < W.length; k++) { v[k] = momentum * v[k] - lr * g[k]; W[k] += v[k]; } };
        upd(this.W1, gW1, this.vW1);
        upd(this.W2, gW2, this.vW2);
        upd(this.W3, gW3, this.vW3);
        for (let i = 0; i < this.h1; i++) { this.vb1[i] = momentum * this.vb1[i] - lr * dz1[i]; this.b1[i] += this.vb1[i]; }
        for (let i = 0; i < this.h2; i++) { this.vb2[i] = momentum * this.vb2[i] - lr * dz2[i]; this.b2[i] += this.vb2[i]; }
        this.vb3[0] = momentum * this.vb3[0] - lr * gb3; this.b3[0] += this.vb3[0];

        return err * err;
    }

    toJSON(): ValueNetWeights {
        return {
            dim: this.dim, h1: this.h1, h2: this.h2,
            W1: Array.from(this.W1), b1: Array.from(this.b1),
            W2: Array.from(this.W2), b2: Array.from(this.b2),
            W3: Array.from(this.W3), b3: Array.from(this.b3),
        };
    }

    static fromJSON(w: ValueNetWeights): ValueNet {
        const net = new ValueNet(w.dim);
        net.h1 = w.h1; net.h2 = w.h2;
        net.W1 = Float64Array.from(w.W1); net.b1 = Float64Array.from(w.b1);
        net.W2 = Float64Array.from(w.W2); net.b2 = Float64Array.from(w.b2);
        net.W3 = Float64Array.from(w.W3); net.b3 = Float64Array.from(w.b3);
        return net;
    }
}
