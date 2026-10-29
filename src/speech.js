/**
 * speech.js — "这句话说完要多久" → 台词该往后挪多久。
 *
 * ## 为什么需要它
 *
 * 台词的 `at` 对齐的是字幕的 `from`，而 `from` 是这句话**开始说**的时刻。
 * 在这一点就开口，等于跟 UP 主同时说话 —— 用户听到的是自己要说的话被念了两遍，
 * 也就是"话还没说完你就插嘴了"。
 *
 * ## 曲线怎么来的
 *
 * 实测这份素材的 ai-zh 字幕：
 *   [03:41.8 → 03:43.3] 登记有50多个人                        7 字 / 1.5s ≈ 4.7 字/秒
 *   [03:32.1 → 03:36.1] 结果发现他住的地址离学校有两个小时路程  21 字 / 4.0s ≈ 5.3 字/秒
 *
 * 取 5 字/秒。但**不该等它说完** —— 说完画面可能已经切走了，那就变成给上一句配词。
 * 等到说了大约一半最自然：
 *
 *   lag = 0.3 + (字数 / 5) × 0.5      夹在 [0.4, 2.0] 秒
 *
 *   1 字 → 0.4    3 字 → 0.6    7 字 → 1.0    13 字 → 1.6    21 字以上 → 2.0
 */

export const SPEECH_LAG_DEFAULT = Object.freeze({
  charsPerSec: 5, fraction: 0.5, pad: 0.3, min: 0.4, max: 2.0,
});

/**
 * 一句话说完大约要多久（取一半，再夹到合理区间）。
 *
 * @param {number} chars 那句话的字数
 * @returns {number} 秒
 */
export function speechLag(chars, o = {}) {
  const { charsPerSec, fraction, pad, min, max } = { ...SPEECH_LAG_DEFAULT, ...o };
  const n = Math.max(0, Number(chars) || 0);
  // 0 字 = 没有句子可参照（空台词/拿不到字幕），不延迟
  if (n === 0) return 0;
  const spoken = (n / charsPerSec) * fraction;
  return Math.min(max, Math.max(min, pad + spoken));
}

/**
 * 在字幕表里找 `at` 附近的那一句（用来数它的字数）。
 *
 * 为什么要有容差：模型写的 `at` 通常是照抄 `from`，但手写偏移、四舍五入都会差个零点几秒。
 * 4 秒内认为"就是这一句"；找不到说明 at 落在两句之间的空档，返回 null（不延迟）。
 */
export function lineNear(segments, at, toleranceSec = 4) {
  const t = Number(at);
  if (!Number.isFinite(t) || !Array.isArray(segments) || segments.length === 0) return null;
  let best = null;
  let bestD = Infinity;
  for (const s of segments) {
    const f = Number(s?.from);
    if (!Number.isFinite(f)) continue;
    const d = Math.abs(f - t);
    if (d < bestD) { bestD = d; best = s; }
  }
  return bestD <= toleranceSec ? best : null;
}

/** `at` 那一刻该往后挪多少秒（字幕不可用时返回 0，退化成原行为） */
export function lagForAt(segments, at) {
  const hit = lineNear(segments, at);
  if (!hit) return 0;
  return speechLag(String(hit.text ?? '').length);
}

/**
 * 给一段循环用的取延迟函数（带 memo）。
 *
 * `dueLine` 每秒会被叫好几次，每次都遍历两百条字幕没必要 —— 而且同一批台词
 * 的 `at` 就固定那么几个，缓存起来几乎零成本。
 */
export function makeLagFn(segments) {
  const memo = new Map();
  return (at) => {
    const t = Number(at);
    if (!Number.isFinite(t)) return 0;
    const key = Math.round(t * 10) / 10;
    if (!memo.has(key)) memo.set(key, lagForAt(segments, key));
    return memo.get(key);
  };
}
