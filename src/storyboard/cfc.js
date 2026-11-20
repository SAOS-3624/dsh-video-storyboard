/**
 * cfc.js — CfC（Closed-form Continuous-time）细胞的**前向**与切点解码。**手写，零依赖。**
 *
 * ## 为什么它在 `src/` 而不是 `bench/`
 *
 * 训练代码在 `bench/eval/train/cfc.mjs`，而 **`bench/` 不进 npm 包** ——
 * 线上阴影链路（`shadow.js`）要用同一份前向，所以它必须住在 `src/`。
 *
 * ## 唯一实现（这条别破）
 *
 * `forward` 只在这里有一份：
 *   - 训练侧 `bench/eval/train/cfc.mjs` **re-export** 它（不要复制、不要改写成"等价"版本）
 *   - 推理侧 `src/storyboard/shadow.js` 直接 import 它
 *
 * 两份实现必然漂，而"训练时好的、上线就崩"是最难查的一类 bug：
 * 评测上看不出来，只表现为分数掉了一点。要改前向就改这一个文件，
 * 然后跑 `bench/eval/train/run.mjs` 开头的梯度检验（`worst < 1e-5`）确认没改坏。
 *
 * ## 数学形式（exp 变体，不是原论文的 sigmoid 门控）
 *
 *     z_t  = [x_t ; h_{t-1}]
 *     vf_t = W_f z_t + b_f          f_t = softplus(vf_t)       > 0，可读作 1/τ
 *     vu_t = W_u z_t + b_u          u_t = tanh(vu_t)
 *     a_t  = exp(-f_t · Δt)                                    保留率 ∈ (0,1)
 *     h_t  = a_t ⊙ h_{t-1} + (1 - a_t) ⊙ u_t
 *     p    = σ(w·h + b)                                        每个读数头
 *
 * `f → 0` 时 `a → 1`，退化成纯累加 —— **正好等于现有 `acc += score`**。
 * 这条退化路径就是"最差也不比现在差"的数学保证。
 *
 * 两个常数（`SP_FLOOR` / `FDT_MAX`）是数值保护，不是超参；改它们等于改模型语义，
 * 会让已训好的权重不再表示同一件事。
 */

/** softplus 的下限。再小就下溢成 0，f 恒为 0、τ 无穷，等于没有泄漏。 */
const SP_FLOOR = 1e-6;
/** `f·Δt` 的上钳。exp(-20) ≈ 2e-9，已经等于"全忘"。 */
const FDT_MAX = 20;

export function softplus(v) {
  return v > 30 ? v : Math.log1p(Math.exp(v));
}

export function sigmoid(v) {
  if (v >= 0) { const e = Math.exp(-v); return 1 / (1 + e); }
  const e = Math.exp(v);
  return e / (1 + e);
}

/**
 * 单序列前向。
 *
 * @param {object} m 模型参数：`{dim, units, zdim, heads, Wf, bf, Wu, bu, w_<head>, b_<head>}`
 * @param {Float32Array|Float64Array} X  (rows × dim)
 * @param {number[]|Int32Array} rows    按时间升序的行号
 * @param {number[]|Float64Array} dts   每步 Δt（秒）
 * @param {{record?:boolean, h0?:Float64Array}} [opts] `record` 只有训练侧需要（BPTT 缓存）
 */
export function forward(m, X, rows, dts, { record = false, h0 = null } = {}) {
  const { dim, units, zdim } = m;
  const T = rows.length;
  const h = new Float64Array(units);
  if (h0) h.set(h0);

  const out = {};
  for (const name of m.heads) out[name] = new Float64Array(T);

  const cache = record ? {
    x: new Float64Array(T * dim),
    hp: new Float64Array(T * units),
    ht: new Float64Array(T * units),
    f: new Float64Array(T * units),
    u: new Float64Array(T * units),
    a: new Float64Array(T * units),
    vf: new Float64Array(T * units),
    dt: new Float64Array(T),
    vo: {},
  } : null;
  if (cache) for (const name of m.heads) cache.vo[name] = new Float64Array(T);

  const z = new Float64Array(zdim);
  for (let t = 0; t < T; t += 1) {
    const base = rows[t] * dim;
    if (cache) {
      cache.hp.set(h, t * units);
      for (let d = 0; d < dim; d += 1) cache.x[t * dim + d] = X[base + d];
    }
    for (let d = 0; d < dim; d += 1) z[d] = X[base + d];
    z.set(h, dim);

    const dt = Math.min(FDT_MAX, Math.max(1e-4, dts[t]));
    if (cache) cache.dt[t] = dt;

    for (let i = 0; i < units; i += 1) {
      const wr = i * zdim;
      let vf = m.bf[i];
      let vu = m.bu[i];
      for (let j = 0; j < zdim; j += 1) {
        const zz = z[j];
        vf += m.Wf[wr + j] * zz;
        vu += m.Wu[wr + j] * zz;
      }
      const f = Math.max(SP_FLOOR, softplus(vf));
      const u = Math.tanh(vu);
      const a = Math.exp(-Math.min(FDT_MAX, f * dt));
      const hp = h[i];
      h[i] = a * hp + (1 - a) * u;
      if (cache) {
        cache.vf[t * units + i] = vf;
        cache.f[t * units + i] = f;
        cache.u[t * units + i] = u;
        cache.a[t * units + i] = a;
        cache.ht[t * units + i] = h[i];
      }
    }

    for (const name of m.heads) {
      const w = m[`w_${name}`];
      let v = m[`b_${name}`][0];
      for (let i = 0; i < units; i += 1) v += w[i] * h[i];
      out[name][t] = sigmoid(v);
      if (cache) cache.vo[name][t] = v;
    }
  }

  return { out, cache, h: Float64Array.from(h) };
}

/**
 * 概率序列 → 切点列表。**后处理必须与线上同形**，否则比出来的数字没有意义。
 *
 * 三步（和 `scan.js` 的 `decideCuts` 后处理同构，只是判据换成了概率）：
 *   1. 概率过阈 `theta`
 *   2. 局部极大（前后 `peakWin` 帧内最大）—— 一刀只留一个点
 *   3. 最小间隔 `minGap`
 *
 * 原来这份代码在 `bench/eval/probe/lr.mjs`（逻辑回归探针），训练侧扫阈值、
 * 评测侧出点、现在线上 shadow 也用同一份 —— 所以搬进 `src/`，bench 那边 re-export。
 *
 * @param {Float32Array|Float64Array} probs 逐帧概率
 * @param {{fps:number, theta?:number, peakWin?:number, minGap?:number, startFrame?:number}} o
 * @returns {number[]} 绝对秒（`startFrame` 参与换算），升序
 */
export function decodeCuts(probs, {
  fps, theta = 0.5, peakWin = 3, minGap = 0.35, startFrame = 0,
}) {
  const n = probs.length;
  const out = [];
  let lastT = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const p = probs[i];
    if (p < theta) continue;
    let isMax = true;
    const lo = Math.max(0, i - peakWin);
    const hi = Math.min(n - 1, i + peakWin);
    for (let j = lo; j <= hi; j += 1) {
      if (probs[j] > p) { isMax = false; break; }
    }
    if (!isMax) continue;
    const t = (i + startFrame) / fps;
    if (t - lastT < minGap) continue;
    out.push(+t.toFixed(3));
    lastT = t;
  }
  return out;
}
