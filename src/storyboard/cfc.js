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
 * ## 热循环里踩过的坑（都是"数学没变、只是白算"的那类）
 *
 * - `m.Wf` / `m.Wu` / `m.bf` / `m.bu` 每步要摸 128 次：提到循环外。
 * - **`m[`w_${name}`]` 是每步每头一次的字符串模板 + 属性查找** —— 这是原来最贵的一行，
 *   比它算的那个 64 次乘加还贵。`HW` / `HB` 预先解出来，热循环只读数组。
 * - `z = [x ; h]` 那个 78 长的拼接数组去掉，改成"先 14 个输入、再 64 个状态"两段循环：
 *   **累加顺序与原来完全一致**（j 从 0 到 zdim-1），所以结果逐位相同。
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

  const heads = m.heads;
  const out = {};
  for (let k = 0; k < heads.length; k += 1) out[heads[k]] = new Float64Array(T);

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
  if (cache) for (const name of heads) cache.vo[name] = new Float64Array(T);

  const Wf = m.Wf;
  const Wu = m.Wu;
  const bf = m.bf;
  const bu = m.bu;
  const HW = new Array(heads.length);
  const HB = new Array(heads.length);
  const HO = new Array(heads.length);
  for (let k = 0; k < heads.length; k += 1) {
    HW[k] = m[`w_${heads[k]}`];
    HB[k] = m[`b_${heads[k]}`][0];
    HO[k] = out[heads[k]];
  }
  const nh = heads.length;
  /**
   * **必须快照上一步的 `h`。**
   *
   * 原来是把 `[x ; h]` 拼进 `z` 再乘，等于给所有单元一份"步初状态"。
   * 如果直接读 `h[j]`，第 i 个单元看到的 j<i 已经是**本步刚更新过**的值 ——
   * 数学上变成另一套（并行 → 串行）递归，概率能差 0.01 量级，而且看不出哪里错。
   * 64 个 double 的拷贝，成本可以忽略。
   */
  const hPrev = new Float64Array(units);

  for (let t = 0; t < T; t += 1) {
    const base = rows[t] * dim;
    if (cache) {
      cache.hp.set(h, t * units);
      for (let d = 0; d < dim; d += 1) cache.x[t * dim + d] = X[base + d];
    }

    const dtRaw = dts[t];
    const dt = dtRaw > FDT_MAX ? FDT_MAX : (dtRaw < 1e-4 ? 1e-4 : dtRaw);
    if (cache) cache.dt[t] = dt;
    hPrev.set(h);

    for (let i = 0; i < units; i += 1) {
      const wr = i * zdim;
      let vf = bf[i];
      let vu = bu[i];
      for (let j = 0; j < dim; j += 1) {
        const xj = X[base + j];
        vf += Wf[wr + j] * xj;
        vu += Wu[wr + j] * xj;
      }
      const wr2 = wr + dim;
      for (let j = 0; j < units; j += 1) {
        const hj = hPrev[j];
        vf += Wf[wr2 + j] * hj;
        vu += Wu[wr2 + j] * hj;
      }
      const f = Math.max(SP_FLOOR, softplus(vf));
      const u = Math.tanh(vu);
      const fdt = f * dt;
      const a = Math.exp(-(fdt > FDT_MAX ? FDT_MAX : fdt));
      const hp = hPrev[i];
      const hi = a * hp + (1 - a) * u;
      h[i] = hi;
      if (cache) {
        const o = t * units + i;
        cache.vf[o] = vf;
        cache.f[o] = f;
        cache.u[o] = u;
        cache.a[o] = a;
        cache.ht[o] = hi;
      }
    }

    for (let k = 0; k < nh; k += 1) {
      const w = HW[k];
      let v = HB[k];
      for (let i = 0; i < units; i += 1) v += w[i] * h[i];
      HO[k][t] = sigmoid(v);
      if (cache) cache.vo[heads[k]][t] = v;
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

/**
 * 自适应阈值：**只看概率序列，不看真值**。
 *
 * ## 为什么固定 θ 不行
 *
 * 模型文件里带的是一个学习期标定的 `theta`（部署模型是 0.92）。BBC 这种纪录片很合适，
 * 但换到快剪素材（SHOT 27 段）每个折的最优 θ 落在 **0.58~0.86** —— 用 0.92 会明显欠检
 * （实测 `shot-4347` 10 刀只报 1 刀，F1 18.2）。而把 θ 直接调到 0.6，BBC 上又会多报。
 *
 * ## 判据：本片的"噪声水平"
 *
 * 一帧的概率高不高，取决于**这条片子平时有多吵**：慢节奏素材 p95 只有 0.05，
 * 0.5 已经是"绝对异常"；快剪/高运动素材 p95 能到 0.8，0.9 都未必是刀。
 * 所以取"每 30 秒一段、各段的 p95"里**最吵的那一段**，乘一个系数当阈值。
 *
 * 用**最吵的那段**而不是全片中位数：慢片里夹一段快剪时，θ 应该按快剪那段的噪声定，
 * 否则那一段会整段被判成"每帧都是刀"。
 *
 * 实测（38 个 case，模型与 case 严格留出）：
 *
 *   固定 0.92      BBC 94.8 / SHOT 69.5
 *   固定 0.6       （SHOT 变好、BBC 崩）
 *   **本规则**     BBC 95.3 / SHOT 76.9（k=1.05，纯 BBC 训练的模型上量的）
 *
 * ## k 怎么定成 1.0 的
 *
 * 上表那个 1.05 是在**纯 BBC 训练**的模型上标的。换成"BBC+SHOT 加权联合训练"的模型后，
 * 概率分布变了，重标一次（38 个 case 全部留出，同一套规则扫 k）：
 *
 *   k      0.90   0.95   1.00   1.05   1.10   1.20   1.50
 *   BBC    95.9   95.7   95.2   95.1   95.0   94.9   94.5
 *   SHOT   76.5   75.6   78.2   77.9   77.2   77.0   76.7
 *
 * 两边的峰**几乎重合**（BBC 0.90 / SHOT 1.00），所以取 **k = 1.0** —— 一套参数两域通用，
 * 不需要按素材类型切开关。曲线很平：0.95~1.10 之间两域都只差 0.5 个点以内。
 *
 * 分块用直方图求分位，不用排序 —— 一小时的片子是 8 万个浮点，排序没必要。
 *
 * @param {Float32Array|Float64Array} probs 逐帧概率
 * @param {{fps?:number, k?:number, winSec?:number, lo?:number, hi?:number}} [o]
 * @returns {number} θ ∈ [lo, hi]
 */
export function pickTheta(probs, {
  fps = 25, k = 1.0, winSec = 30, lo = 0.5, hi = 0.95,
} = {}) {
  const n = probs?.length ?? 0;
  if (!n) return lo;
  const BINS = 256;
  /** 一段的 p95（直方图累计，O(段长)） */
  const p95Of = (from, to) => {
    const hist = new Uint32Array(BINS);
    for (let i = from; i < to; i += 1) {
      const b = probs[i] * BINS;
      hist[b >= BINS ? BINS - 1 : (b < 0 ? 0 : b | 0)] += 1;
    }
    const want = Math.max(1, Math.ceil((to - from) * 0.95));
    let acc = 0;
    for (let b = 0; b < BINS; b += 1) {
      acc += hist[b];
      if (acc >= want) return (b + 1) / BINS;
    }
    return 1;
  };
  const per = Math.max(1, Math.round(winSec * (fps > 0 ? fps : 25)));
  let noisy = 0;
  if (n <= per) {
    noisy = p95Of(0, n);
  } else {
    for (let i = 0; i + per <= n; i += per) noisy = Math.max(noisy, p95Of(i, i + per));
    // 尾巴不足一段时也要算上：最后几帧往往是片尾黑场，噪声低，但"漏算"比"多算"危险
    if (n % per > per * 0.3) noisy = Math.max(noisy, p95Of(n - (n % per), n));
  }
  const th = noisy * k;
  return Math.min(hi, Math.max(lo, +th.toFixed(3)));
}
