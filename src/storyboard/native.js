/**
 * native.js — 端到端取帧的**推理实现**（纯 JS、零依赖、浏览器/Node 通用）。
 *
 * ## 它是什么
 *
 * 输入一串低清帧，输出每帧的"硬切概率"。整个链路只有一次前向：
 *
 * ```
 * 3 帧 RGB + 两组帧差 = 15 通道 @ 48×27
 *   → 6 层（dw3×3 / pw1×1 + GroupNorm + LeakyReLU）
 *   → 网格池化 6×4（576）
 *   → 线性 576→32                    每帧 32 维嵌入
 *   → [emb ; Δemb]（64）
 *   → CfC 48 单元（带长时记忆）
 *   → logit → sigmoid
 * ```
 *
 * 31,072 参数 / 331k MAC / 约 0.75 ms/帧（单线程 Float32）。
 *
 * ## 与训练侧的关系（重要）
 *
 * 训练实现在 `bench/eval/train/native/`，**不进 npm 包**。这里是一份独立的推理实现，
 * 只含前向，去掉了训练需要的缓冲管理与反向传播。
 *
 * 「两份实现」的风险由 `test/native-golden.mjs` 兜底：它用同一份权重和同样输入，
 * 逐层比对训练侧与推理侧的中间结果，要求 `max|Δ| < 1e-5`。改了任何一边都要跑它。
 *
 * ## 为什么推理侧不直接复用训练代码
 *
 * 训练侧为了 BPTT 要保存每帧每层的全部激活（约 147 KB/帧），还要 6 层反向；
 * 推理只需要一遍前向，缓冲区按帧复用即可（约 40 KB/帧，与 T 无关）。
 * 强行合并会让包多背 800 行永远不会执行的代码。
 */

/* ── 结构常量（顺序即契约，必须与训练侧一致） ─────────────────────── */

export const FW = 48;
export const FH = 27;
/** 输入通道：3 帧 RGB + 两组帧差 RGB。 */
export const CH_IN = 15;
/** 各层通道数。 */
export const CH = Object.freeze({ l1: 15, l2: 16, l3: 16, l4: 16, l5: 24, l6: 24, emb: 32 });
/** GroupNorm 组数。 */
export const GN = Object.freeze({ l1: 5, l2: 4, l3: 4, l4: 4, l5: 4, l6: 4 });
/** 特征图尺寸。 */
export const W1 = 24; export const H1 = 14;   // 48×27 --s2--> 24×14
export const W2 = 12; export const H2 = 7;    // 24×14 --s2--> 12×7
export const N1 = W1 * H1;                    // 336
export const N4 = W2 * H2;                    // 84
/** 网格池化格数。 */
export const GH = 4; export const GW = 6;
export const GPOOL = CH.l6 * GH * GW;         // 576
/** 时序（CfC）。 */
export const U = 48;                          // 隐状态维度
export const TIN = CH.emb * 2;                // 64 = [emb ; Δemb]
/** LeakyReLU 斜率（与训练侧一致）。 */
const SLOPE = 0.1;
/** GroupNorm 的 eps。 */
const GN_EPS = 1e-5;

/* ── 模型加载 ────────────────────────────────────────────────────── */

/**
 * @param {object} json `toJSON()` 的产物（`format: 'native-cfc-v2'`）
 * @returns {object} 参数表，全部 Float32Array
 */
export function loadModel(json) {
  if (!json || json.format !== 'native-cfc-v2') {
    throw new Error(`模型格式不认识：${json && json.format}`);
  }
  if (json.fw !== FW || json.fh !== FH) {
    throw new Error(`分辨率不匹配：模型 ${json.fw}×${json.fh}，本实现 ${FW}×${FH}`);
  }
  const p = {};
  for (const [k, v] of Object.entries(json.params)) p[k] = Float32Array.from(v);
  for (const need of ['l1w', 'l2w', 'l3w', 'l4w', 'l5w', 'l6w', 'l7w', 'cWf', 'cWu', 'hw']) {
    if (!p[need]) throw new Error(`模型缺少参数 ${need}`);
  }
  return p;
}

/** 参数总量（用于日志/自检）。 */
export function paramCount(p) {
  let n = 0;
  for (const k of Object.keys(p)) n += p[k].length;
  return n;
}

/* ── 缓冲（按帧复用，与序列长度无关） ────────────────────────────── */

function createScratch() {
  const F = Float32Array;
  return {
    x: new F(CH_IN * FW * FH),
    p1: new F(CH.l1 * N1), a1: new F(CH.l1 * N1),
    p2: new F(CH.l2 * N1), a2: new F(CH.l2 * N1),
    p3: new F(CH.l3 * N1), a3: new F(CH.l3 * N1),
    p4: new F(CH.l4 * N4), a4: new F(CH.l4 * N4),
    p5: new F(CH.l5 * N4), a5: new F(CH.l5 * N4),
    p6: new F(CH.l6 * N4), a6: new F(CH.l6 * N4),
    gp: new F(GPOOL),
    emb: new F(CH.emb),
    txc: new F(TIN),
    gnStat: { mean: new F(8), rstd: new F(8) },
    h: new F(U),
    hPrev: new F(U),
    vf: new F(U),
    a: new F(U),
    uu: new F(U),
  };
}

/* ── 算子（只前向） ──────────────────────────────────────────────── */

const outSize = (w, s) => Math.floor((w + s - 1) / s);

/** depthwise 3×3，stride 可 1/2，same padding。 */
function dw3x3(src, w, b, cin, W, H, stride, dst) {
  const wo = outSize(W, stride);
  const ho = outSize(H, stride);
  const n = W * H;
  const on = wo * ho;
  for (let c = 0; c < cin; c += 1) {
    const sb = c * n;
    const db = c * on;
    const wb = c * 9;
    const bias = b[c];
    for (let y = 0; y < ho; y += 1) {
      const sy = y * stride;
      for (let x = 0; x < wo; x += 1) {
        const sx = x * stride;
        let acc = bias;
        for (let ky = 0; ky < 3; ky += 1) {
          const yy = sy + ky - 1;
          if (yy < 0 || yy >= H) continue;
          const row = sb + yy * W;
          const wr = wb + ky * 3;
          for (let kx = 0; kx < 3; kx += 1) {
            const xx = sx + kx - 1;
            if (xx < 0 || xx >= W) continue;
            acc += src[row + xx] * w[wr + kx];
          }
        }
        dst[db + y * wo + x] = acc;
      }
    }
  }
}

/** 1×1 卷积（通道混合）。 */
function pw1x1(src, w, b, cin, cout, n, dst) {
  for (let o = 0; o < cout; o += 1) {
    const ob = o * n;
    const wb = o * cin;
    const bias = b[o];
    for (let i = 0; i < n; i += 1) dst[ob + i] = bias;
    for (let c = 0; c < cin; c += 1) {
      const sb = c * n;
      const wc = w[wb + c];
      if (wc === 0) continue;
      for (let i = 0; i < n; i += 1) dst[ob + i] += src[sb + i] * wc;
    }
  }
}

/** GroupNorm（组内跨通道+跨位置）。 */
function groupNorm(src, gamma, beta, C, n, groups, dst, stat) {
  const cg = C / groups;
  const N = cg * n;
  for (let g = 0; g < groups; g += 1) {
    const c0 = g * cg;
    let s = 0;
    let s2 = 0;
    for (let c = c0; c < c0 + cg; c += 1) {
      const b = c * n;
      for (let i = 0; i < n; i += 1) { const v = src[b + i]; s += v; s2 += v * v; }
    }
    const mu = s / N;
    const va = Math.max(0, s2 / N - mu * mu);
    const rstd = 1 / Math.sqrt(va + GN_EPS);
    void stat;
    for (let c = c0; c < c0 + cg; c += 1) {
      const b = c * n;
      const sc = gamma[c] * rstd;
      const sh = beta[c] - mu * sc;
      for (let i = 0; i < n; i += 1) dst[b + i] = src[b + i] * sc + sh;
    }
  }
}

/** LeakyReLU，原地。 */
function leaky(x, n) {
  for (let i = 0; i < n; i += 1) if (x[i] < 0) x[i] *= SLOPE;
}

/** 自适应网格池化（与训练侧的 span 规则一致）。 */
function gridPool(src, C, H, W, gh, gw, dst) {
  const n = H * W;
  for (let c = 0; c < C; c += 1) {
    const sb = c * n;
    const db = c * gh * gw;
    for (let gy = 0; gy < gh; gy += 1) {
      const y0 = Math.floor((gy * H) / gh);
      const y1 = Math.floor(((gy + 1) * H) / gh);
      for (let gx = 0; gx < gw; gx += 1) {
        const x0 = Math.floor((gx * W) / gw);
        const x1 = Math.floor(((gx + 1) * W) / gw);
        let s = 0;
        for (let y = y0; y < y1; y += 1) {
          const row = sb + y * W;
          for (let x = x0; x < x1; x += 1) s += src[row + x];
        }
        const cnt = (y1 - y0) * (x1 - x0);
        dst[db + gy * gw + gx] = cnt > 0 ? s / cnt : 0;
      }
    }
  }
}

const sigmoid = (v) => {
  if (v >= 0) { const e = Math.exp(-v); return 1 / (1 + e); }
  const e = Math.exp(v);
  return e / (1 + e);
};

/* ── 输入拼装 ────────────────────────────────────────────────────── */

const K = 0.00392156862745098;   // 1/255

/**
 * 把 t-1 / t / t+1 三帧拼成 15 通道（CHW）。
 * 通道 0-8 = 三帧 RGB；9-11 = I_t − I_{t−1}；12-14 = I_{t+1} − I_t。
 *
 * @param {Uint8Array} raw 整段裸帧（N × 48×27×3，RGB 交织）
 */
function buildInput(raw, t, n, dst) {
  const N = FW * FH;
  const N3 = N * 3;
  const p = t > 0 ? t - 1 : t;
  const q = t + 1 < n ? t + 1 : t;
  for (let k = 0; k < 3; k += 1) {
    const src = k === 0 ? p : (k === 1 ? t : q);
    const base = src * N3;
    const ob = k * 3 * N;
    for (let i = 0; i < N; i += 1) {
      const i3 = base + i * 3;
      dst[ob + i] = raw[i3] * K - 0.5;
      dst[ob + N + i] = raw[i3 + 1] * K - 0.5;
      dst[ob + 2 * N + i] = raw[i3 + 2] * K - 0.5;
    }
  }
  const bp = p * N3;
  const bt = t * N3;
  const bq = q * N3;
  for (let i = 0; i < N; i += 1) {
    const i3 = i * 3;
    for (let c = 0; c < 3; c += 1) {
      dst[(9 + c) * N + i] = (raw[bt + i3 + c] - raw[bp + i3 + c]) * K;
      dst[(12 + c) * N + i] = (raw[bq + i3 + c] - raw[bt + i3 + c]) * K;
    }
  }
}

/* ── 主流程 ──────────────────────────────────────────────────────── */

/**
 * 对一段素材跑前向，返回逐帧硬切概率。
 *
 * @param {object} p  `loadModel()` 的结果
 * @param {Uint8Array} raw 裸帧，N × 48×27×3
 * @param {number} n 总帧数
 * @param {{fps?:number}} opt `fps` 决定 CfC 的 Δt，默认 25
 * @returns {Float32Array} 长度 n 的概率
 */
export function predict(p, raw, n, { fps = 25 } = {}) {
  const dt = 1 / fps;
  const s = createScratch();
  const embSeq = new Float32Array(CH.emb * n);   // [c][t]
  const probs = new Float32Array(n);

  /* 1) 逐帧空间编码 → 嵌入（每帧独立，可复用缓冲） */
  for (let t = 0; t < n; t += 1) {
    buildInput(raw, t, n, s.x);

    dw3x3(s.x, p.l1w, p.l1b, CH.l1, FW, FH, 2, s.p1);
    groupNorm(s.p1, p.n1g, p.n1b, CH.l1, N1, GN.l1, s.a1, s.gnStat);
    leaky(s.a1, CH.l1 * N1);

    pw1x1(s.a1, p.l2w, p.l2b, CH.l1, CH.l2, N1, s.p2);
    groupNorm(s.p2, p.n2g, p.n2b, CH.l2, N1, GN.l2, s.a2, s.gnStat);
    leaky(s.a2, CH.l2 * N1);

    dw3x3(s.a2, p.l3w, p.l3b, CH.l3, W1, H1, 1, s.p3);
    groupNorm(s.p3, p.n3g, p.n3b, CH.l3, N1, GN.l3, s.a3, s.gnStat);
    leaky(s.a3, CH.l3 * N1);

    dw3x3(s.a3, p.l4w, p.l4b, CH.l4, W1, H1, 2, s.p4);
    groupNorm(s.p4, p.n4g, p.n4b, CH.l4, N4, GN.l4, s.a4, s.gnStat);
    leaky(s.a4, CH.l4 * N4);

    pw1x1(s.a4, p.l5w, p.l5b, CH.l4, CH.l5, N4, s.p5);
    groupNorm(s.p5, p.n5g, p.n5b, CH.l5, N4, GN.l5, s.a5, s.gnStat);
    leaky(s.a5, CH.l5 * N4);

    dw3x3(s.a5, p.l6w, p.l6b, CH.l6, W2, H2, 1, s.p6);
    groupNorm(s.p6, p.n6g, p.n6b, CH.l6, N4, GN.l6, s.a6, s.gnStat);
    leaky(s.a6, CH.l6 * N4);

    gridPool(s.a6, CH.l6, H2, W2, GH, GW, s.gp);
    pw1x1(s.gp, p.l7w, p.l7b, GPOOL, CH.emb, 1, s.emb);
    for (let c = 0; c < CH.emb; c += 1) embSeq[c * n + t] = s.emb[c];
  }

  /* 2) 时序：CfC（带长时记忆）+ 输出头 */
  s.h.fill(0);
  const Z = TIN + U;
  const txc = s.txc;
  for (let t = 0; t < n; t += 1) {
    // Tx = [emb ; Δemb]
    for (let c = 0; c < CH.emb; c += 1) {
      const v = embSeq[c * n + t];
      txc[c] = v;
      txc[CH.emb + c] = t > 0 ? v - embSeq[c * n + t - 1] : 0;
    }
    s.hPrev.set(s.h);
    for (let i = 0; i < U; i += 1) {
      const wr = i * Z;
      let vf = p.cbf[i];
      let vu = p.cbu[i];
      for (let j = 0; j < TIN; j += 1) {
        const z = txc[j];
        vf += p.cWf[wr + j] * z;
        vu += p.cWu[wr + j] * z;
      }
      for (let j = 0; j < U; j += 1) {
        const z = s.hPrev[j];
        vf += p.cWf[wr + TIN + j] * z;
        vu += p.cWu[wr + TIN + j] * z;
      }
      const f = vf > 30 ? vf : Math.log1p(Math.exp(vf));   // softplus
      const uu = Math.tanh(vu);
      const a = Math.exp(-f * dt);
      s.h[i] = a * s.hPrev[i] + (1 - a) * uu;
      s.vf[i] = vf;
      s.a[i] = a;
      s.uu[i] = uu;
    }
    // 输出头：[h ; Δemb] · w + b
    let logit = p.hb[0];
    for (let i = 0; i < U; i += 1) logit += p.hw[i] * s.h[i];
    for (let j = 0; j < CH.emb; j += 1) logit += p.hw[U + j] * txc[CH.emb + j];
    probs[t] = sigmoid(logit);
  }
  return probs;
}

/**
 * 概率序列 → 切点时刻（秒）。
 *
 * 三步：过阈 → 局部极大（±`peakWin`）→ 最小间隔 `minGap`。
 * 与训练侧判卷用的是同一套规则（`decodeCuts`），改这里必须同步改评测。
 *
 * @param {Float32Array} probs
 * @param {{fps:number, theta?:number, peakWin?:number, minGap?:number, startFrame?:number}} o
 * @returns {number[]} 绝对秒，升序
 */
export function decodeCuts(probs, { fps, theta = 0.97, peakWin = 3, minGap = 0.35, startFrame = 0 }) {
  const n = probs.length;
  const out = [];
  let lastT = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const v = probs[i];
    if (v < theta) continue;
    let isMax = true;
    const lo = Math.max(0, i - peakWin);
    const hi = Math.min(n - 1, i + peakWin);
    for (let j = lo; j <= hi; j += 1) {
      if (probs[j] > v) { isMax = false; break; }
    }
    if (!isMax) continue;
    const t = (i + startFrame) / fps;
    if (t - lastT < minGap) continue;
    out.push(+t.toFixed(3));
    lastT = t;
  }
  return out;
}
