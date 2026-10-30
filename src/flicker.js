/**
 * flicker.js — 识别"只有局部在闪、底图不动"的蒙版 / 故障效果，并顺手给出堆叠后的画面。
 *
 * 为什么需要：MAD / 赛博故障类的素材里，经常是**底下的画面稳定，只有叠加的蒙版在闪**
 * （屏幕上的小字、网格、扫描线）。这种片段在逐帧分数上和"快速剪辑"长得一模一样 ——
 * 每帧都在变、分数都高 —— 但两者该被完全相反地处理：
 *
 *   快速剪辑 → 每一帧都是新内容，要摊成子格
 *   闪烁蒙版 → 闪的不是内容，摊开等于把噪声放大 9 倍；应该**堆叠成一张**把闪烁平均掉
 *
 * 判据不看时间上的周期性（闪烁可以是 ABAB、也可以是 ABCDEFGABCDEFG，甚至无规律），
 * 只看**空间上有没有一块从来没动过的底**：
 *
 *   coreRatio    所有帧都贴着时间中位数的像素比例   —— 有底就高，剪辑就低
 *   flickerRatio 在容差内外来回翻转 ≥ minFlips 次的像素比例 —— 闪烁高，走过的人低
 *
 * 剪辑的每一个镜头只占 1/k 的时间，中位数只等于其中一帧，其它镜头大片偏离 → coreRatio 低。
 * 所以这一个量就能把两者分开，且与周期无关。
 */

/**
 * 逐像素时间统计 + 中位数堆叠。
 *
 * @param {Buffer[]} frames 同尺寸的 rgb24 帧
 * @param {{tolerance?:number, minFlips?:number}} opts
 *        tolerance: 通道差超过它算"偏离底图"（0–255）
 *        minFlips:  来回跨越几次算"在闪"
 * @returns {{median:Buffer, coreRatio:number, flickerRatio:number, pixels:number}}
 */
export function analyseStack(frames, { tolerance = 18, minFlips = 3 } = {}) {
  if (!Array.isArray(frames) || frames.length < 3) {
    throw new RangeError('analyseStack needs at least 3 frames');
  }
  const n = frames.length;
  const len = frames[0].length;
  if (frames.some((f) => f.length !== len)) {
    throw new RangeError('all frames must have the same length');
  }

  const median = Buffer.alloc(len);
  let core = 0;
  let flicker = 0;

  const vals = new Array(n);
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < n; c++) vals[c] = frames[c][i];
    vals.sort((a, b) => a - b);
    // 偶数个用中间两个的均值：比直接取低中位更不容易偏向某一帧
    const m = n % 2 === 1 ? vals[(n - 1) / 2] : Math.round((vals[n / 2 - 1] + vals[n / 2]) / 2);
    median[i] = m;
  }

  // 逐像素判"是否一直贴着中位数"（core）与"是否来回翻"（flicker）。
  // 按像素（三通道一起）判，而不是按通道：单通道抖动不足以说明"这块在闪"。
  const px = len / 3;
  for (let p = 0; p < px; p++) {
    const base = p * 3;
    let near = true;        // 每一帧都在容差内
    let flips = 0;
    let prevFar = null;
    for (let c = 0; c < n; c++) {
      const f = frames[c];
      const d = Math.max(
        Math.abs(f[base] - median[base]),
        Math.abs(f[base + 1] - median[base + 1]),
        Math.abs(f[base + 2] - median[base + 2]),
      );
      const far = d >= tolerance;
      if (far) near = false;
      if (prevFar !== null && far !== prevFar) flips += 1;
      prevFar = far;
    }
    if (near) core += 1;
    if (flips >= minFlips) flicker += 1;
  }

  return {
    median,
    coreRatio: +(core / px).toFixed(3),
    flickerRatio: +(flicker / px).toFixed(3),
    pixels: px,
  };
}

/**
 * 判定：这一段是"闪烁蒙版"而不是"快速剪辑"。
 *
 * **判据是 flickerRatio（反复翻转的像素比例），不是 coreRatio。** 这是在真素材上量出来的：
 *
 *   窗口              core(全帧)  core(≥50%帧)  flick(翻转≥3)
 *   3:29-3:30 闪烁段     0.003      0.620        0.739
 *   真快切 46s           0.358      0.923        0.242
 *   真快切 10s           0.000      0.225        0.070
 *
 * core 在真快切上反而更高 —— 因为一个镜头如果占住窗口一半以上的帧，中位数就等于它，
 * 它那几帧全都"贴着中位数"。所以 core 不能用来区分。
 *
 * 能区分的是**时间形态**：真剪辑是一次性从 A 换成 B（每个像素只翻一次），
 * 故障闪烁是像素在底图和噪点之间来回跳（翻很多次）。
 */
export function isFlicker({ flickerRatio }, { minFlicker = 0.5 } = {}) {
  return Number.isFinite(flickerRatio) && flickerRatio >= minFlicker;
}

